// Persistence layer: a single SQLite file on the Fly volume (DATA_DIR,
// defaulting to /data — see docs/adr/0001-persistence-and-realtime-stack.md
// for why SQLite-on-volume rather than a managed cloud database, and
// docs/adr/0002-identity-and-lobbies.md for the move from one global shared
// counter to persistent identity + multiple lobbies).
//
// node:sqlite's DatabaseSync is synchronous, which is what makes handlers
// like `bump` and `joinLobby` atomic on the event loop: there is no `await`
// between reading state and writing it, so two players acting at the "same"
// moment still serialize through Node's single thread rather than racing —
// see ADR 0001. WAL mode is a durability/read-concurrency setting on top of
// that, not the concurrency story.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DEFAULT_LOBBY_ID = "default";

export interface StoredLobby {
  lobbyId: string;
  name: string;
  capacity: number;
  started: boolean;
  count: number;
  lastBumpedBy: string | null;
}

export interface StoredMember {
  playerId: string;
  /** This player's locked-in callsign for this specific lobby — see ADR 0002. */
  name: string;
}

export interface ResolvedPlayer {
  playerId: string;
  token: string;
}

export type JoinLobbyResult =
  | { ok: true; lobby: StoredLobby }
  | { ok: false; reason: "not-found" | "full" | "started" }
  | { ok: false; reason: "name-required"; lobbyId: string }
  | { ok: false; reason: "name-taken" };

export interface Store {
  resolvePlayer(token: string | undefined): ResolvedPlayer;
  getCurrentLobbyId(playerId: string): string | null;
  getLobby(lobbyId: string): StoredLobby | null;
  getLobbyMembers(lobbyId: string): StoredMember[];
  getMemberName(lobbyId: string, playerId: string): string | null;
  listLobbies(): StoredLobby[];
  createLobby(name: string, capacity: number, playerId: string, callsign: string): StoredLobby;
  joinLobby(playerId: string, lobbyId: string, callsign: string | undefined): JoinLobbyResult;
  startLobby(lobbyId: string): StoredLobby | null;
  bump(lobbyId: string, playerId: string): StoredLobby | null;
  close(): void;
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  migrate(db);

  const insertPlayer = db.prepare(
    "INSERT INTO players (token, player_id, created_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  );
  const selectPlayerByToken = db.prepare(
    "SELECT player_id AS playerId FROM players WHERE token = ?",
  );

  const selectCurrentLobbyId = db.prepare(
    "SELECT lobby_id AS lobbyId FROM lobby_members WHERE player_id = ?",
  );
  const selectLobby = db.prepare(`
    SELECT id AS lobbyId, name, capacity, started, count, last_bumped_by AS lastBumpedBy
    FROM lobbies WHERE id = ?
  `);
  const selectAllLobbies = db.prepare(`
    SELECT id AS lobbyId, name, capacity, started, count, last_bumped_by AS lastBumpedBy
    FROM lobbies ORDER BY rowid
  `);
  const selectMembers = db.prepare(`
    SELECT player_id AS playerId, name FROM lobby_members WHERE lobby_id = ?
  `);
  const selectMemberName = db.prepare(
    "SELECT name FROM lobby_members WHERE lobby_id = ? AND player_id = ?",
  );
  const countMembers = db.prepare("SELECT COUNT(*) AS n FROM lobby_members WHERE lobby_id = ?");
  // Case-insensitive, trimmed-at-the-call-site comparison: this lobby's
  // callsigns double as how the brief's "the app tells them apart"
  // requirement is satisfied within a game, so two members reading as the
  // same name would defeat that.
  const selectNameTaken = db.prepare(
    "SELECT 1 FROM lobby_members WHERE lobby_id = ? AND lower(name) = lower(?) AND player_id != ?",
  );
  const insertLobby = db.prepare(`
    INSERT INTO lobbies (id, name, capacity, started, count, last_bumped_by, updated_at)
    VALUES (?, ?, ?, 0, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  // player_id is the lobby_members primary key, so a player can only ever be
  // in one lobby at a time: INSERT OR REPLACE on it IS the "move to a
  // different lobby" operation, atomically, in one statement.
  const upsertMembership = db.prepare(
    "INSERT OR REPLACE INTO lobby_members (lobby_id, player_id, name) VALUES (?, ?, ?)",
  );
  const updateBump = db.prepare(`
    UPDATE lobbies
    SET count = count + 1, last_bumped_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);
  const updateStart = db.prepare(`
    UPDATE lobbies SET started = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `);

  // SQLite has no boolean type — `started` is stored as 0/1 and converted
  // at the store boundary so nothing above this file deals with integers.
  function readLobby(lobbyId: string): StoredLobby | null {
    const row = selectLobby.get(lobbyId) as (Omit<StoredLobby, "started"> & { started: number }) | undefined;
    return row ? { ...row, started: row.started !== 0 } : null;
  }

  return {
    resolvePlayer(token) {
      if (token) {
        const row = selectPlayerByToken.get(token) as { playerId: string } | undefined;
        if (row) return { playerId: row.playerId, token };
      }
      const playerId = randomUUID();
      const newToken = randomUUID();
      insertPlayer.run(newToken, playerId);
      return { playerId, token: newToken };
    },

    getCurrentLobbyId(playerId) {
      const row = selectCurrentLobbyId.get(playerId) as { lobbyId: string } | undefined;
      return row?.lobbyId ?? null;
    },

    getLobby: readLobby,

    getLobbyMembers(lobbyId) {
      return selectMembers.all(lobbyId) as unknown as StoredMember[];
    },

    getMemberName(lobbyId, playerId) {
      const row = selectMemberName.get(lobbyId, playerId) as { name: string } | undefined;
      return row?.name ?? null;
    },

    listLobbies() {
      const rows = selectAllLobbies.all() as unknown as (Omit<StoredLobby, "started"> & { started: number })[];
      return rows.map((row) => ({ ...row, started: row.started !== 0 }));
    },

    createLobby(name, capacity, playerId, callsign) {
      const lobbyId = randomUUID();
      insertLobby.run(lobbyId, name, capacity);
      // The creator is this lobby's first member, so there's nobody to
      // collide with — no name-taken check needed on creation.
      upsertMembership.run(lobbyId, playerId, callsign);
      const lobby = readLobby(lobbyId);
      if (!lobby) throw new Error("lobby vanished immediately after insert");
      return lobby;
    },

    joinLobby(playerId, lobbyId, callsign) {
      const lobby = readLobby(lobbyId);
      if (!lobby) return { ok: false, reason: "not-found" };

      const existingName = selectMemberName.get(lobbyId, playerId) as { name: string } | undefined;
      const isNewMember = !existingName;

      // "No late join once a game begins" (PLAN.md, settled by ANU-006): a
      // started lobby only still accepts its own existing members (e.g. a
      // reconnect), never a new one.
      if (isNewMember && lobby.started) return { ok: false, reason: "started" };

      if (!isNewMember) {
        // Reconnect, or switching back to a lobby already joined: the
        // callsign is already locked — ignore whatever (if anything) was
        // sent and keep it, per ADR 0002.
        upsertMembership.run(lobbyId, playerId, existingName.name);
        return { ok: true, lobby };
      }

      const { n } = countMembers.get(lobbyId) as { n: number };
      if (n >= lobby.capacity) return { ok: false, reason: "full" };
      // First join to this lobby: the callsign is required and gets locked in.
      if (!callsign) return { ok: false, reason: "name-required", lobbyId };
      if (selectNameTaken.get(lobbyId, callsign, playerId)) return { ok: false, reason: "name-taken" };

      upsertMembership.run(lobbyId, playerId, callsign);
      return { ok: true, lobby };
    },

    startLobby(lobbyId) {
      const result = updateStart.run(lobbyId);
      if (result.changes === 0) return null;
      return readLobby(lobbyId);
    },

    bump(lobbyId, playerId) {
      const member = selectMemberName.get(lobbyId, playerId) as { name: string } | undefined;
      if (!member) return null; // not a member of this lobby — nothing to attribute the bump to
      const result = updateBump.run(member.name, lobbyId);
      if (result.changes === 0) return null;
      return readLobby(lobbyId);
    },

    close(): void {
      db.close();
    },
  };
}

// PRAGMA user_version-gated migrations, so a schema change ships without
// wiping the Fly volume's existing data — see ADR 0002. Each version's
// migration is additive except v1, which replaces ANU-005's single global
// `counter` table (now superseded by per-lobby state) since nothing has
// been deployed against it yet.
function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };

  if (version < 1) {
    db.exec("BEGIN");
    try {
      db.exec("DROP TABLE IF EXISTS counter");

      db.exec(`
        CREATE TABLE players (
          token TEXT PRIMARY KEY,
          player_id TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE lobbies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          capacity INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          last_bumped_by TEXT,
          updated_at TEXT NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE lobby_members (
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          player_id TEXT PRIMARY KEY REFERENCES players(player_id)
        )
      `);

      // A fresh boot with an empty database still has one lobby to show on
      // Server Browse / auto-join new players into, so two marker windows
      // land in the same place with no out-of-band coordination. Capacity
      // 12 (not 16) even here, now that v2 below tightens the column's
      // valid range to PLAN.md's real 4-12 rule.
      db.prepare(
        `INSERT OR IGNORE INTO lobbies (id, name, capacity, count, last_bumped_by, updated_at)
         VALUES (?, 'Default', 12, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).run(DEFAULT_LOBBY_ID);

      db.exec("PRAGMA user_version = 1");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // v2 (ANU-009): "no late join once a game begins" (PLAN.md, settled by
  // ANU-006) needs a lobby to carry started/not-started state. Existing
  // lobbies default to not-started (0) — they were created before this
  // column existed, i.e. before anything could have "started" them.
  if (version < 2) {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE lobbies ADD COLUMN started INTEGER NOT NULL DEFAULT 0");
      db.exec("PRAGMA user_version = 2");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // v3 (ANU-009 follow-up): names move from the player (global) to the
  // membership (per-lobby) — see ADR 0002's "per-lobby callsign" addendum.
  // `lobby_members.name` is backfilled from the player's old global name so
  // an in-progress game found on upgrade keeps a readable name rather than
  // an empty string; it's editable going forward only in the sense that a
  // *different* lobby locks in a fresh callsign; this lobby's is still
  // locked. `players.name` is then dropped — it's no longer read anywhere.
  if (version < 3) {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE lobby_members ADD COLUMN name TEXT");
      db.exec(`
        UPDATE lobby_members
        SET name = (SELECT name FROM players WHERE players.player_id = lobby_members.player_id)
      `);
      db.exec("UPDATE lobby_members SET name = 'player' WHERE name IS NULL");
      db.exec("ALTER TABLE players DROP COLUMN name");
      db.exec("PRAGMA user_version = 3");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
