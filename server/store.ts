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
  count: number;
  lastBumpedBy: string | null;
}

export interface StoredMember {
  playerId: string;
  name: string;
}

export interface ResolvedPlayer {
  playerId: string;
  token: string;
}

export type JoinLobbyResult =
  | { ok: true; lobby: StoredLobby }
  | { ok: false, reason: "not-found" | "full" };

export interface Store {
  resolvePlayer(name: string, token: string | undefined): ResolvedPlayer;
  getCurrentLobbyId(playerId: string): string | null;
  getLobby(lobbyId: string): StoredLobby | null;
  getLobbyMembers(lobbyId: string): StoredMember[];
  listLobbies(): StoredLobby[];
  createLobby(name: string, capacity: number): StoredLobby;
  joinLobby(playerId: string, lobbyId: string): JoinLobbyResult;
  bump(lobbyId: string, playerName: string): StoredLobby | null;
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
    "INSERT INTO players (token, player_id, name, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
  );
  const selectPlayerByToken = db.prepare(
    "SELECT player_id AS playerId FROM players WHERE token = ?",
  );
  const updatePlayerName = db.prepare("UPDATE players SET name = ? WHERE player_id = ?");

  const selectCurrentLobbyId = db.prepare(
    "SELECT lobby_id AS lobbyId FROM lobby_members WHERE player_id = ?",
  );
  const selectLobby = db.prepare(`
    SELECT id AS lobbyId, name, capacity, count, last_bumped_by AS lastBumpedBy
    FROM lobbies WHERE id = ?
  `);
  const selectAllLobbies = db.prepare(`
    SELECT id AS lobbyId, name, capacity, count, last_bumped_by AS lastBumpedBy
    FROM lobbies ORDER BY rowid
  `);
  const selectMembers = db.prepare(`
    SELECT p.player_id AS playerId, p.name AS name
    FROM lobby_members lm JOIN players p ON p.player_id = lm.player_id
    WHERE lm.lobby_id = ?
  `);
  const countMembers = db.prepare("SELECT COUNT(*) AS n FROM lobby_members WHERE lobby_id = ?");
  const insertLobby = db.prepare(`
    INSERT INTO lobbies (id, name, capacity, count, last_bumped_by, updated_at)
    VALUES (?, ?, ?, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  // player_id is the lobby_members primary key, so a player can only ever be
  // in one lobby at a time: INSERT OR REPLACE on it IS the "move to a
  // different lobby" operation, atomically, in one statement.
  const upsertMembership = db.prepare(
    "INSERT OR REPLACE INTO lobby_members (lobby_id, player_id) VALUES (?, ?)",
  );
  const updateBump = db.prepare(`
    UPDATE lobbies
    SET count = count + 1, last_bumped_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);

  function readLobby(lobbyId: string): StoredLobby | null {
    return (selectLobby.get(lobbyId) as StoredLobby | undefined) ?? null;
  }

  return {
    resolvePlayer(name, token) {
      if (token) {
        const row = selectPlayerByToken.get(token) as { playerId: string } | undefined;
        if (row) {
          updatePlayerName.run(name, row.playerId);
          return { playerId: row.playerId, token };
        }
      }
      const playerId = randomUUID();
      const newToken = randomUUID();
      insertPlayer.run(newToken, playerId, name);
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

    listLobbies() {
      return selectAllLobbies.all() as unknown as StoredLobby[];
    },

    createLobby(name, capacity) {
      const lobbyId = randomUUID();
      insertLobby.run(lobbyId, name, capacity);
      const lobby = readLobby(lobbyId);
      if (!lobby) throw new Error("lobby vanished immediately after insert");
      return lobby;
    },

    joinLobby(playerId, lobbyId) {
      const lobby = readLobby(lobbyId);
      if (!lobby) return { ok: false, reason: "not-found" };

      const alreadyMember = selectCurrentLobbyId.get(playerId) as { lobbyId: string } | undefined;
      if (alreadyMember?.lobbyId !== lobbyId) {
        const { n } = countMembers.get(lobbyId) as { n: number };
        if (n >= lobby.capacity) return { ok: false, reason: "full" };
      }

      upsertMembership.run(lobbyId, playerId);
      return { ok: true, lobby };
    },

    bump(lobbyId, playerName) {
      const result = updateBump.run(playerName, lobbyId);
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
      // land in the same place with no out-of-band coordination.
      db.prepare(
        `INSERT OR IGNORE INTO lobbies (id, name, capacity, count, last_bumped_by, updated_at)
         VALUES (?, 'Default', 16, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).run(DEFAULT_LOBBY_ID);

      db.exec("PRAGMA user_version = 1");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
