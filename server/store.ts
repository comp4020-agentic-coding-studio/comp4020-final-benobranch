// Persistence layer: a single SQLite file on the Fly volume (DATA_DIR,
// defaulting to /data — see docs/adr/0001-persistence-and-realtime-stack.md
// for why SQLite-on-volume rather than a managed cloud database, and
// docs/adr/0002-identity-and-lobbies.md for the move from one global shared
// counter to persistent identity + multiple lobbies).
//
// node:sqlite's DatabaseSync is synchronous, which is what makes handlers
// like `joinLobby` atomic on the event loop: there is no `await` between
// reading state and writing it, so two players acting at the "same" moment
// still serialize through Node's single thread rather than racing — see ADR
// 0001. WAL mode is a durability/read-concurrency setting on top of that,
// not the concurrency story.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PLAYER_COLORS } from "./protocol.ts";
import { createPerkHook } from "./perks.ts";
import { seedBaseUnitTypes } from "./units.ts";
import { seedSkillGatedUnitTypes } from "./skill-tree.ts";

export const DEFAULT_LOBBY_ID = "default";

export interface StoredLobby {
  lobbyId: string;
  name: string;
  capacity: number;
  started: boolean;
  /**
   * Stored-timestamp rule (ADR 0001 / issues/ANU-013.md): set once, the
   * first time this lobby starts, never reset by a later no-op startLobby
   * call. Game-elapsed time is derived from this at read/broadcast time
   * (server/time.ts's elapsedMs), never from a running timer.
   */
  startedAt: string | null;
}

export interface StoredMember {
  playerId: string;
  /** This player's locked-in callsign for this specific lobby — see ADR 0002. */
  name: string;
  /** Assigned once at join, unique per lobby, locked for its lifetime — same precedent as callsign. */
  color: string;
  /** This player's kickoff spawn suburb (territory.ts's assignSpawnOwnership) — null before the lobby has started. */
  spawnSalCode: string | null;
}

/**
 * Scrap only, as of ANU-019 — TFLOPS is no longer a stored per-member
 * balance (it was ANU-016's spend-based skill-tree currency; PLAN.md's
 * actual design has data centers' TFLOPS as a live speed multiplier on
 * skill-tree research, computed on the fly by server/tflops.ts, not
 * accrued/spent). `lobby_members.tflops`/`tflops_last_accrued_at` are
 * dropped in migration v7.
 */
export interface MemberEconomy {
  scrap: number;
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
  /** Ordered by join time — stable across reconnects, unlike rowid (see joinLobby's note on INSERT OR REPLACE). */
  getLobbyMembers(lobbyId: string): StoredMember[];
  getMemberName(lobbyId: string, playerId: string): string | null;
  getMemberColor(lobbyId: string, playerId: string): string | null;
  getMemberEconomy(lobbyId: string, playerId: string): MemberEconomy | null;
  listLobbies(): StoredLobby[];
  createLobby(name: string, capacity: number, playerId: string, callsign: string): StoredLobby;
  joinLobby(playerId: string, lobbyId: string, callsign: string | undefined): JoinLobbyResult;
  startLobby(lobbyId: string): StoredLobby | null;
  perks: import("./perks.ts").PerkHook;
  /**
   * The single shared DatabaseSync connection (ADR 0001: one process, one
   * connection, no `await` between read and write in a handler) — exposed
   * so territory.ts/units.ts/factories.ts/skill-tree.ts (per this issue's
   * file-layout convention) can prepare statements against their own
   * tables without opening a second connection, which would reintroduce
   * the interleaving ADR 0001 relies on DatabaseSync's synchronous,
   * single-connection shape to prevent.
   */
  db: DatabaseSync;
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
  seedBaseUnitTypes(db);
  seedSkillGatedUnitTypes(db);

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
    SELECT id AS lobbyId, name, capacity, started, started_at AS startedAt
    FROM lobbies WHERE id = ?
  `);
  const selectAllLobbies = db.prepare(`
    SELECT id AS lobbyId, name, capacity, started, started_at AS startedAt
    FROM lobbies ORDER BY rowid
  `);
  // joined_at (not rowid) orders members: INSERT OR REPLACE (below) deletes
  // and reinserts a row on every reconnect, which would otherwise reorder
  // members by rowid on every reconnect — join order needs to stay stable
  // since ANU-013's spawn-ownership-at-kickoff assigns spawns by it.
  const selectMembers = db.prepare(`
    SELECT player_id AS playerId, name, color, spawn_sal_code AS spawnSalCode FROM lobby_members
    WHERE lobby_id = ? ORDER BY joined_at, player_id
  `);
  const selectMemberRow = db.prepare(
    "SELECT name, color FROM lobby_members WHERE lobby_id = ? AND player_id = ?",
  );
  const selectMemberEconomy = db.prepare(
    "SELECT scrap FROM lobby_members WHERE lobby_id = ? AND player_id = ?",
  );
  const countMembers = db.prepare("SELECT COUNT(*) AS n FROM lobby_members WHERE lobby_id = ?");
  const selectUsedColors = db.prepare("SELECT color FROM lobby_members WHERE lobby_id = ?");
  // Case-insensitive, trimmed-at-the-call-site comparison: this lobby's
  // callsigns double as how the brief's "the app tells them apart"
  // requirement is satisfied within a game, so two members reading as the
  // same name would defeat that.
  const selectNameTaken = db.prepare(
    "SELECT 1 FROM lobby_members WHERE lobby_id = ? AND lower(name) = lower(?) AND player_id != ?",
  );
  const insertLobby = db.prepare(`
    INSERT INTO lobbies (id, name, capacity, started, started_at, updated_at)
    VALUES (?, ?, ?, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  // First join to a lobby, OR a player who already belongs to a different
  // lobby creating/joining this one (player_id is lobby_members' primary
  // key — a player has exactly one membership at a time, so this IS the
  // "switch lobby" operation). ON CONFLICT(player_id), not a plain INSERT:
  // a plain INSERT throws UNIQUE constraint failed the moment an existing
  // member of lobby A creates/joins lobby B (the ordinary Server Browse
  // flow) — uncaught, that crashes the ws message handler. The conflict
  // branch explicitly resets economy/perk columns to their defaults, since
  // a new lobby is a fresh game, not a continuation of the old one's.
  const insertMembership = db.prepare(`
    INSERT INTO lobby_members (lobby_id, player_id, name, color, joined_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(player_id) DO UPDATE SET
      lobby_id = excluded.lobby_id,
      name = excluded.name,
      color = excluded.color,
      joined_at = excluded.joined_at,
      scrap = 0,
      perk_factory_build_speed_multiplier = 1,
      perk_factory_build_cost_multiplier = 1,
      perk_scrap_per_kill_multiplier = 1,
      perk_capture_speed_multiplier = 1,
      perk_data_transfer_speed_multiplier = 1
  `);
  // Reconnect / re-send of createLobby|joinLobby for a lobby already joined:
  // touches only name/color (both already locked and unchanged in practice —
  // see joinLobby below), never economy columns. An UPDATE, not INSERT OR
  // REPLACE, which would delete-and-reinsert the row and reset scrap/
  // perk multipliers to their defaults on every reconnect.
  const touchMembership = db.prepare(
    "UPDATE lobby_members SET name = ?, color = ? WHERE lobby_id = ? AND player_id = ?",
  );
  const updateStart = db.prepare(`
    UPDATE lobbies SET started = 1, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND started = 0
  `);

  // SQLite has no boolean type — `started` is stored as 0/1 and converted
  // at the store boundary so nothing above this file deals with integers.
  function readLobby(lobbyId: string): StoredLobby | null {
    const row = selectLobby.get(lobbyId) as (Omit<StoredLobby, "started"> & { started: number }) | undefined;
    return row ? { ...row, started: row.started !== 0 } : null;
  }

  function assignColor(lobbyId: string): string {
    const used = new Set((selectUsedColors.all(lobbyId) as { color: string }[]).map((r) => r.color));
    const free = PLAYER_COLORS.find((c) => !used.has(c));
    if (!free) throw new Error(`no free color left in a lobby of capacity ${PLAYER_COLORS.length}`);
    return free;
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
      const row = selectMemberRow.get(lobbyId, playerId) as { name: string } | undefined;
      return row?.name ?? null;
    },

    getMemberColor(lobbyId, playerId) {
      const row = selectMemberRow.get(lobbyId, playerId) as { color: string } | undefined;
      return row?.color ?? null;
    },

    getMemberEconomy(lobbyId, playerId) {
      const row = selectMemberEconomy.get(lobbyId, playerId) as MemberEconomy | undefined;
      return row ?? null;
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
      insertMembership.run(lobbyId, playerId, callsign, assignColor(lobbyId));
      const lobby = readLobby(lobbyId);
      if (!lobby) throw new Error("lobby vanished immediately after insert");
      return lobby;
    },

    joinLobby(playerId, lobbyId, callsign) {
      const lobby = readLobby(lobbyId);
      if (!lobby) return { ok: false, reason: "not-found" };

      const existing = selectMemberRow.get(lobbyId, playerId) as { name: string; color: string } | undefined;
      const isNewMember = !existing;

      // "No late join once a game begins" (PLAN.md, settled by ANU-006): a
      // started lobby only still accepts its own existing members (e.g. a
      // reconnect), never a new one.
      if (isNewMember && lobby.started) return { ok: false, reason: "started" };

      if (!isNewMember) {
        // Reconnect, or switching back to a lobby already joined: the
        // callsign and color are already locked — ignore whatever (if
        // anything) was sent and keep them, per ADR 0002. An UPDATE that
        // writes back the same values, not INSERT OR REPLACE, which would
        // delete-and-reinsert the row and reset economy/perk columns to
        // their defaults (see touchMembership's comment above).
        touchMembership.run(existing.name, existing.color, lobbyId, playerId);
        return { ok: true, lobby };
      }

      const { n } = countMembers.get(lobbyId) as { n: number };
      if (n >= lobby.capacity) return { ok: false, reason: "full" };
      // First join to this lobby: the callsign is required and gets locked in.
      if (!callsign) return { ok: false, reason: "name-required", lobbyId };
      if (selectNameTaken.get(lobbyId, callsign, playerId)) return { ok: false, reason: "name-taken" };

      insertMembership.run(lobbyId, playerId, callsign, assignColor(lobbyId));
      return { ok: true, lobby };
    },

    startLobby(lobbyId) {
      // WHERE started = 0 in updateStart's SQL makes this idempotent: a
      // second startLobby call for an already-started lobby is a no-op,
      // changes === 0, so startedAt is never clobbered by a later call —
      // the stored-timestamp rule (ADR 0001) depends on startedAt being
      // set exactly once.
      const result = updateStart.run(lobbyId);
      if (result.changes === 0) return null;
      return readLobby(lobbyId);
    },

    perks: createPerkHook(db),
    db,

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

  // v4 (ANU-011): ANU-005's throwaway shared-counter columns are retired now
  // that a started lobby shows the real map instead of a bump counter —
  // dropped, not just unread, per ADR 0002's precedent of not leaving a
  // migrated-away column lying around.
  if (version < 4) {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE lobbies DROP COLUMN count");
      db.exec("ALTER TABLE lobbies DROP COLUMN last_bumped_by");
      db.exec("PRAGMA user_version = 4");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // v5 (ANU-013): the shared foundation ANU-014 through ANU-017 build on —
  // one bump covering every table/column all four downstream issues need,
  // so they don't each add their own (colliding) user_version bump. See
  // issues/ANU-013.md's Done-when for the full rationale per piece.
  if (version < 5) {
    db.exec("BEGIN");
    try {
      // --- per-member color, economy, perk multipliers --- //
      db.exec("ALTER TABLE lobby_members ADD COLUMN color TEXT");
      db.exec("ALTER TABLE lobby_members ADD COLUMN joined_at TEXT");
      db.exec("ALTER TABLE lobby_members ADD COLUMN scrap INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE lobby_members ADD COLUMN tflops INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE lobby_members ADD COLUMN tflops_last_accrued_at TEXT");
      db.exec("ALTER TABLE lobby_members ADD COLUMN perk_factory_build_speed_multiplier REAL NOT NULL DEFAULT 1");
      db.exec("ALTER TABLE lobby_members ADD COLUMN perk_factory_build_cost_multiplier REAL NOT NULL DEFAULT 1");
      db.exec("ALTER TABLE lobby_members ADD COLUMN perk_scrap_per_kill_multiplier REAL NOT NULL DEFAULT 1");
      db.exec("ALTER TABLE lobby_members ADD COLUMN perk_capture_speed_multiplier REAL NOT NULL DEFAULT 1");
      db.exec("ALTER TABLE lobby_members ADD COLUMN perk_data_transfer_speed_multiplier REAL NOT NULL DEFAULT 1");

      // Backfill: existing members (pre-color schema) get a color and a
      // joined_at, assigned in rowid order (the closest proxy to join order
      // available pre-migration — ANU-013 introduces the real joined_at
      // column going forward, as inserted by insertMembership above).
      // joined_at values are staggered by 1ms per member (computed in JS,
      // bound as a parameter) rather than each set to strftime('now') — a
      // whole migration transaction can complete within one SQLite
      // datetime-function tick, which would give every member in a lobby
      // the identical joined_at and silently undo the rowid ordering this
      // backfill is trying to preserve.
      const existingMembers = db
        .prepare("SELECT lobby_id AS lobbyId, player_id AS playerId FROM lobby_members ORDER BY lobby_id, rowid")
        .all() as { lobbyId: string; playerId: string }[];
      const backfillColor = db.prepare(
        "UPDATE lobby_members SET color = ?, joined_at = ? WHERE lobby_id = ? AND player_id = ?",
      );
      const colorIndexByLobby = new Map<string, number>();
      const backfillBaseMs = Date.now();
      for (const m of existingMembers) {
        const i = colorIndexByLobby.get(m.lobbyId) ?? 0;
        const joinedAt = new Date(backfillBaseMs + i).toISOString();
        backfillColor.run(PLAYER_COLORS[i % PLAYER_COLORS.length], joinedAt, m.lobbyId, m.playerId);
        colorIndexByLobby.set(m.lobbyId, i + 1);
      }

      // --- lobby start time (stored-timestamp rule, ADR 0001) --- //
      db.exec("ALTER TABLE lobbies ADD COLUMN started_at TEXT");
      // A lobby already marked started (pre-this-column) has no real start
      // time on record; updated_at is the closest available proxy (it's
      // touched by the same UPDATE that sets started=1 — see updateStart).
      db.exec("UPDATE lobbies SET started_at = updated_at WHERE started = 1");

      // --- suburb ownership + capture-state columns (ANU-017 implements the state machine) --- //
      db.exec(`
        CREATE TABLE suburb_ownership (
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          sal_code TEXT NOT NULL,
          owner_player_id TEXT REFERENCES players(player_id),
          capturing_player_id TEXT REFERENCES players(player_id),
          capture_started_at TEXT,
          capture_accumulated_ms INTEGER NOT NULL DEFAULT 0,
          contesting_player_id TEXT REFERENCES players(player_id),
          PRIMARY KEY (lobby_id, sal_code)
        )
      `);

      // --- units + unit_types (ANU-014 fleshes out real stats/combat) --- //
      db.exec(`
        CREATE TABLE unit_types (
          key TEXT PRIMARY KEY,
          health INTEGER NOT NULL,
          damage INTEGER NOT NULL,
          build_cost_scrap INTEGER NOT NULL,
          build_time_ms INTEGER NOT NULL,
          -- "fly" ignores adjacency/corridor (drones); "ground" requires
          -- road-adjacency to an owned suburb (robots) — see issues/ANU-014.md.
          movement_mode TEXT NOT NULL,
          -- Non-null for an ANU-016 skill-tree-gated variant row (e.g. an
          -- upgraded drone/robot) a player must unlock before building.
          requires_skill_node TEXT
        )
      `);
      // Seed rows are NOT inserted here — see seedBaseUnitTypes below. A
      // migration runs once per schema version; both ANU-014 (real
      // drone/robot stats) and ANU-016 (gated variant rows) need to add or
      // change unit_types rows without each needing their own colliding
      // user_version bump, which a migration-time INSERT would force them
      // into. An idempotent boot-time upsert does that instead.
      db.exec(`
        CREATE TABLE units (
          id TEXT PRIMARY KEY,
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          owner_player_id TEXT NOT NULL REFERENCES players(player_id),
          sal_code TEXT NOT NULL,
          unit_type_key TEXT NOT NULL REFERENCES unit_types(key),
          health INTEGER NOT NULL,
          spawned_at TEXT NOT NULL,
          -- In-transit state (ANU-014's drone "mid-flight" visual): both
          -- null when the unit isn't currently moving.
          destination_sal_code TEXT,
          move_started_at TEXT
        )
      `);

      // --- factories (ANU-015 owns the production-queue logic) --- //
      db.exec(`
        CREATE TABLE factories (
          id TEXT PRIMARY KEY,
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          sal_code TEXT NOT NULL,
          owner_player_id TEXT NOT NULL REFERENCES players(player_id),
          -- Production queue, stored-timestamp style: null when idle.
          queued_unit_type_key TEXT REFERENCES unit_types(key),
          queue_started_at TEXT
        )
      `);

      // --- skill_nodes (ANU-016 owns the node definitions + purchase logic) --- //
      db.exec(`
        CREATE TABLE skill_nodes (
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          player_id TEXT NOT NULL REFERENCES players(player_id),
          node_id TEXT NOT NULL,
          unlocked_at TEXT NOT NULL,
          PRIMARY KEY (lobby_id, player_id, node_id)
        )
      `);

      db.exec("PRAGMA user_version = 5");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // v6 (ANU-022): units are no longer scrap-queued one-at-a-time — every
  // factory auto-produces every buildable unit_types row concurrently, each
  // on its own stored-timestamp cycle (ADR 0001's rule, same as the single
  // queue this replaces). `factories`' single queue slot
  // (queued_unit_type_key/queue_started_at) can't represent "building
  // several types at once", so it's replaced by a child table keyed per
  // (factory, unit type) — see server/factories.ts's `createFactoryProduction`
  // table.
  if (version < 6) {
    db.exec("BEGIN");
    try {
      // Existing factories' in-flight single-queue build has no equivalent
      // in the new per-type-cycle model (it was "the one type the player
      // picked", not "every type always cycling") — simplest correct
      // carry-forward is to start every existing factory's cycle for every
      // currently-unlocked unit type fresh from this migration's instant,
      // rather than inventing a conversion from the old partial progress.
      // factories.ts's settle() lazily inserts a row for any (factory, type)
      // pair it finds missing anyway, so this backfill (further down) is an
      // optimization (existing factories start producing immediately)
      // rather than a correctness requirement for ones created after this
      // version. Read the id list now, before factories is rebuilt below.
      const existingFactoryIds = db.prepare("SELECT id FROM factories").all() as { id: string }[];
      const baseUnitTypeKeys = db
        .prepare("SELECT key FROM unit_types WHERE requires_skill_node IS NULL")
        .all() as { key: string }[];

      // Rebuilt via a new table + copy rather than two `ALTER TABLE ...
      // DROP COLUMN` statements: SQLite's DROP COLUMN rewrites the stored
      // CREATE TABLE text, and when the column immediately follows a `--`
      // inline comment (as both of these do — see the v5 migration's
      // `factories` DDL above) that rewrite corrupts the schema ("incomplete
      // input" on the very next ALTER/read) — a real engine limitation, not
      // a mistake in these statements. A table rebuild sidesteps it entirely.
      // This has to run BEFORE factory_production is created below: once
      // that table's rows FK-reference factories(id), DROP TABLE factories
      // fails the foreign-key check, even inside the same transaction.
      db.exec(`
        CREATE TABLE factories_new (
          id TEXT PRIMARY KEY,
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          sal_code TEXT NOT NULL,
          owner_player_id TEXT NOT NULL REFERENCES players(player_id)
        )
      `);
      db.exec(
        "INSERT INTO factories_new (id, lobby_id, sal_code, owner_player_id) SELECT id, lobby_id, sal_code, owner_player_id FROM factories",
      );
      db.exec("DROP TABLE factories");
      db.exec("ALTER TABLE factories_new RENAME TO factories");

      db.exec(`
        CREATE TABLE factory_production (
          factory_id TEXT NOT NULL REFERENCES factories(id),
          unit_type_key TEXT NOT NULL REFERENCES unit_types(key),
          cycle_started_at TEXT NOT NULL,
          PRIMARY KEY (factory_id, unit_type_key)
        )
      `);
      const insertCycle = db.prepare(
        "INSERT OR IGNORE INTO factory_production (factory_id, unit_type_key, cycle_started_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      );
      for (const { id: factoryId } of existingFactoryIds) {
        for (const { key } of baseUnitTypeKeys) insertCycle.run(factoryId, key);
      }

      // unit_types.build_cost_scrap no longer gates a build (scrap now only
      // funds buildFactory, a flat constant in server/factories.ts, not a
      // per-unit-type cost) — but server/units.ts's attackSuburb still
      // credits the attacker this same amount on a kill (PLAN.md: scrap is
      // "earned by destroying enemy units"), independent of what building a
      // unit costs. Renamed rather than dropped-and-recreated, so existing
      // seeded values survive the migration unchanged, and so its new name
      // doesn't read as a leftover build-cost field.
      db.exec("ALTER TABLE unit_types RENAME COLUMN build_cost_scrap TO scrap_value");

      db.exec("PRAGMA user_version = 6");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // v7 (ANU-025): a player's base marker needs to know which suburb they
  // were originally assigned at kickoff, distinct from (and outliving
  // changes to) current suburb_ownership — see territory.ts's
  // assignSpawnOwnership, which now also writes here. Existing lobbies have
  // no way to recover a past kickoff's assignment, so this backfills NULL
  // (no base marker) for anyone who started a game before this version
  // rather than guessing from current ownership. `ADD COLUMN`, not `DROP
  // COLUMN` — issues/ANU-023.md's schema-corruption quirk only triggers on
  // DROP, so no rebuild-via-copy needed here.
  if (version < 7) {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE lobby_members ADD COLUMN spawn_sal_code TEXT");
      db.exec("PRAGMA user_version = 7");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // v8 (ANU-019): TFLOPS stops being a stored, spendable balance — PLAN.md's
  // actual design has a data center's TFLOPS rating as a speed multiplier
  // on skill-tree research, not a currency, so "a player's TFLOPS" is now
  // computed live from currently-held data centers (server/tflops.ts), and
  // ANU-013's `tflops`/`tflops_last_accrued_at` columns (never read by
  // anything outside the old spend-based purchaseNode) are dead weight.
  // Both were added via a standalone `ALTER TABLE ... ADD COLUMN` in v5 with
  // no inline comment immediately preceding either in the stored CREATE
  // TABLE text, so issues/ANU-023.md's DROP-COLUMN-after-a-comment
  // corruption trigger doesn't apply here — a plain DROP COLUMN is safe,
  // no rebuild-via-copy needed.
  //
  // Replaces ANU-016's spend-based purchaseNode with time-gated research:
  // at most one in-progress node per player, stored-timestamp style
  // (ADR 0001) like factory_production.cycle_started_at — settled lazily
  // via elapsedMs at read/broadcast time, never an armed timer.
  if (version < 8) {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE lobby_members DROP COLUMN tflops");
      db.exec("ALTER TABLE lobby_members DROP COLUMN tflops_last_accrued_at");

      db.exec(`
        CREATE TABLE skill_research (
          lobby_id TEXT NOT NULL REFERENCES lobbies(id),
          player_id TEXT NOT NULL REFERENCES players(player_id),
          node_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          PRIMARY KEY (lobby_id, player_id)
        )
      `);

      db.exec("PRAGMA user_version = 8");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
