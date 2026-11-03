// Factory production queue (ANU-015), on top of ANU-013's `factories` table
// and ANU-014's `unit_types`/occupancy primitive. Per issues/ANU-013.md's
// file-layout convention: server-side logic for this system lives in its
// own module.
//
// Two design calls flagged in issues/ANU-013.md's Notes, confirmed with the
// user via AskUserQuestion before this module was written (see
// issues/ANU-015.md's Resolution):
//   1. A second (and later) factory can be built in ANY suburb the player
//      currently owns — no adjacency-to-an-existing-factory restriction.
//   2. Capturing a suburb TRANSFERS the factory standing in it to the
//      capturing player (including any in-progress build) rather than
//      destroying it — see transferFactoryOwnership, which ANU-017's
//      capture state machine calls once a capture completes.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { validSalCodes } from "./map-data.ts";
import { createPerkHook } from "./perks.ts";
import { elapsedMs, nowIso } from "./time.ts";
import type { Units } from "./units.ts";
import type { FactoryState } from "./protocol.ts";

/**
 * Flat scrap cost to build an additional factory (first one per player is
 * free, placed at kickoff — see spawnFactories). Not specified by the
 * user's request beyond "can build more," so a value had to be chosen: set
 * at 5-10x a single base unit's build cost (drone 2 scrap, robot 4 scrap —
 * server/units.ts's seedBaseUnitTypes) so expanding production capacity is
 * a meaningful economic investment, not a trivial add-on. Deliberately NOT
 * scaled by `factoryBuildCostMultiplier` — that perk is read elsewhere
 * (queueUnit, below) for the cost of the UNITS a factory produces, per
 * issues/ANU-015.md citing it from the "production queue" bullet; a skill
 * tree node that makes units cheaper to build isn't the same thing as
 * making a new factory cheaper to build, and nothing in ANU-016's roster
 * names the latter.
 */
export const FACTORY_BUILD_COST_SCRAP = 20;

export type BuildFactoryResult =
  | { ok: true; factory: FactoryState }
  | { ok: false; reason: "unknown-suburb" | "not-owner" | "already-exists" | "insufficient-scrap" };

export type QueueUnitResult =
  | { ok: true; factory: FactoryState }
  | { ok: false; reason: "unknown-factory" | "not-owner" | "busy" | "unknown-unit-type" | "locked" | "insufficient-scrap" };

export interface Factories {
  /**
   * Called once from index.ts's `startLobby` handler, right after
   * `territory.assignSpawnOwnership` — reads back each player's
   * just-assigned spawn suburb from `suburb_ownership` directly (same
   * cross-module shared-table read pattern units.ts's `groundCanReach`
   * already uses for the same table) rather than recomputing the spawn
   * table itself, which is exactly the capacity-vs-player-count bug
   * issues/ANU-013.md's Resolution found and fixed in territory.ts — this
   * module must not reintroduce it by guessing spawns a second way.
   */
  spawnFactories(lobbyId: string, memberPlayerIds: string[]): void;
  buildFactory(lobbyId: string, ownerPlayerId: string, salCode: string): BuildFactoryResult;
  queueUnit(lobbyId: string, ownerPlayerId: string, factoryId: string, unitTypeKey: string): QueueUnitResult;
  /** ANU-017's capture state machine calls this once a capture completes. */
  transferFactoryOwnership(lobbyId: string, salCode: string, newOwnerPlayerId: string): void;
  /** Settles any builds that have completed, then returns current state for broadcast. */
  getFactories(lobbyId: string): FactoryState[];
}

interface UnitTypeRow {
  build_cost_scrap: number;
  build_time_ms: number;
  requires_skill_node: string | null;
}

interface FactoryRow {
  id: string;
  sal_code: string;
  ownerPlayerId: string;
  queuedUnitTypeKey: string | null;
  queueStartedAt: string | null;
}

export function createFactories(db: DatabaseSync, units: Units): Factories {
  const perks = createPerkHook(db);

  const selectUnitType = db.prepare(
    "SELECT build_cost_scrap, build_time_ms, requires_skill_node FROM unit_types WHERE key = ?",
  );
  const insertFactory = db.prepare(
    "INSERT INTO factories (id, lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?, ?)",
  );
  const selectFactory = db.prepare(`
    SELECT id, sal_code, owner_player_id AS ownerPlayerId, queued_unit_type_key AS queuedUnitTypeKey, queue_started_at AS queueStartedAt
    FROM factories WHERE id = ? AND lobby_id = ?
  `);
  const selectFactoriesInLobby = db.prepare(`
    SELECT id, sal_code, owner_player_id AS ownerPlayerId, queued_unit_type_key AS queuedUnitTypeKey, queue_started_at AS queueStartedAt
    FROM factories WHERE lobby_id = ?
  `);
  const selectFactoryBySuburb = db.prepare("SELECT id FROM factories WHERE lobby_id = ? AND sal_code = ?");
  const selectOwnedSuburbForPlayer = db.prepare(
    "SELECT sal_code AS salCode FROM suburb_ownership WHERE lobby_id = ? AND owner_player_id = ? LIMIT 1",
  );
  const selectSuburbOwner = db.prepare(
    "SELECT owner_player_id AS ownerPlayerId FROM suburb_ownership WHERE lobby_id = ? AND sal_code = ?",
  );
  const hasUnlockedNode = db.prepare(
    "SELECT 1 FROM skill_nodes WHERE lobby_id = ? AND player_id = ? AND node_id = ?",
  );
  // Same WHERE-guarded UPDATE shape as store.ts's startLobby (`WHERE started
  // = 0`) and units.ts's scrap credit — a single synchronous statement with
  // no `await` between the balance check and the deduction, so two
  // near-simultaneous queue/build requests against the same balance can't
  // both read "affordable" before either writes (ADR 0001).
  const deductScrapIfAffordable = db.prepare(
    "UPDATE lobby_members SET scrap = scrap - ? WHERE lobby_id = ? AND player_id = ? AND scrap >= ?",
  );
  const setQueue = db.prepare("UPDATE factories SET queued_unit_type_key = ?, queue_started_at = ? WHERE id = ?");
  const clearQueue = db.prepare("UPDATE factories SET queued_unit_type_key = NULL, queue_started_at = NULL WHERE id = ?");
  const updateFactoryOwner = db.prepare("UPDATE factories SET owner_player_id = ? WHERE lobby_id = ? AND sal_code = ?");

  /** Build-speed-multiplier-adjusted duration a queued unit needs before it's complete. */
  function effectiveBuildTimeMs(ownerPlayerId: string, lobbyId: string, baseBuildTimeMs: number): number {
    const speedMultiplier = perks.getPerkMultipliers(lobbyId, ownerPlayerId).factoryBuildSpeedMultiplier;
    const safeSpeedMultiplier = speedMultiplier > 0 ? speedMultiplier : 1; // defend against a malformed perk value dividing by zero
    return baseBuildTimeMs / safeSpeedMultiplier;
  }

  /**
   * Finds every factory in this lobby whose queued build has reached its
   * (speed-multiplier-adjusted) duration, places the resulting unit via
   * units.ts's occupancy primitive at the factory's suburb for the
   * factory's CURRENT owner (not whoever queued it — a captured factory's
   * in-progress build completes for its new owner, per this issue's
   * confirmed capture rule), and clears the queue. Called before every
   * read/broadcast and from index.ts's ~1s ticker — never an armed
   * setTimeout (ADR 0001's stored-timestamp rule).
   */
  function settle(lobbyId: string): void {
    const rows = selectFactoriesInLobby.all(lobbyId) as unknown as FactoryRow[];
    for (const row of rows) {
      if (!row.queuedUnitTypeKey || !row.queueStartedAt) continue;
      const unitType = selectUnitType.get(row.queuedUnitTypeKey) as unknown as UnitTypeRow | undefined;
      if (!unitType) continue; // shouldn't happen — queued against a since-removed unit type
      const duration = effectiveBuildTimeMs(row.ownerPlayerId, lobbyId, unitType.build_time_ms);
      if (elapsedMs(row.queueStartedAt) >= duration) {
        units.placeUnit(lobbyId, row.ownerPlayerId, row.sal_code, row.queuedUnitTypeKey);
        clearQueue.run(row.id);
      }
    }
  }

  function toFactoryState(lobbyId: string, row: FactoryRow): FactoryState {
    if (!row.queuedUnitTypeKey || !row.queueStartedAt) {
      return { id: row.id, sal_code: row.sal_code, ownerPlayerId: row.ownerPlayerId, queuedUnitTypeKey: null, queueProgressFraction: null };
    }
    const unitType = selectUnitType.get(row.queuedUnitTypeKey) as unknown as UnitTypeRow | undefined;
    // Should always resolve (settle() runs first and clears completed/orphaned queues), but
    // degrade to "just queued" rather than throw if a unit type vanished mid-build.
    const duration = unitType ? effectiveBuildTimeMs(row.ownerPlayerId, lobbyId, unitType.build_time_ms) : 1;
    const fraction = unitType ? Math.max(0, Math.min(1, elapsedMs(row.queueStartedAt) / duration)) : 0;
    return {
      id: row.id,
      sal_code: row.sal_code,
      ownerPlayerId: row.ownerPlayerId,
      queuedUnitTypeKey: row.queuedUnitTypeKey,
      queueProgressFraction: fraction,
    };
  }

  return {
    spawnFactories(lobbyId, memberPlayerIds) {
      for (const playerId of memberPlayerIds) {
        const row = selectOwnedSuburbForPlayer.get(lobbyId, playerId) as { salCode: string } | undefined;
        if (!row) continue; // no spawn assigned to this player (e.g. no spawn-table entry for this player count — same gap territory.ts's assignSpawnOwnership documents)
        insertFactory.run(randomUUID(), lobbyId, row.salCode, playerId);
      }
    },

    buildFactory(lobbyId, ownerPlayerId, salCode) {
      if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
      const owner = selectSuburbOwner.get(lobbyId, salCode) as { ownerPlayerId: string | null } | undefined;
      if (!owner || owner.ownerPlayerId !== ownerPlayerId) return { ok: false, reason: "not-owner" };
      if (selectFactoryBySuburb.get(lobbyId, salCode)) return { ok: false, reason: "already-exists" };

      const result = deductScrapIfAffordable.run(FACTORY_BUILD_COST_SCRAP, lobbyId, ownerPlayerId, FACTORY_BUILD_COST_SCRAP);
      if (result.changes === 0) return { ok: false, reason: "insufficient-scrap" };

      const id = randomUUID();
      insertFactory.run(id, lobbyId, salCode, ownerPlayerId);
      return { ok: true, factory: { id, sal_code: salCode, ownerPlayerId, queuedUnitTypeKey: null, queueProgressFraction: null } };
    },

    queueUnit(lobbyId, ownerPlayerId, factoryId, unitTypeKey) {
      settle(lobbyId); // free up a factory whose previous build just finished before judging "busy"

      const row = selectFactory.get(factoryId, lobbyId) as unknown as FactoryRow | undefined;
      if (!row) return { ok: false, reason: "unknown-factory" };
      if (row.ownerPlayerId !== ownerPlayerId) return { ok: false, reason: "not-owner" };
      if (row.queuedUnitTypeKey) return { ok: false, reason: "busy" };

      const unitType = selectUnitType.get(unitTypeKey) as unknown as UnitTypeRow | undefined;
      if (!unitType) return { ok: false, reason: "unknown-unit-type" };
      if (unitType.requires_skill_node && !hasUnlockedNode.get(lobbyId, ownerPlayerId, unitType.requires_skill_node)) {
        return { ok: false, reason: "locked" };
      }

      const costMultiplier = perks.getPerkMultipliers(lobbyId, ownerPlayerId).factoryBuildCostMultiplier;
      const cost = Math.max(0, Math.round(unitType.build_cost_scrap * costMultiplier));

      const result = deductScrapIfAffordable.run(cost, lobbyId, ownerPlayerId, cost);
      if (result.changes === 0) return { ok: false, reason: "insufficient-scrap" };

      const queueStartedAt = nowIso();
      setQueue.run(unitTypeKey, queueStartedAt, factoryId);
      return {
        ok: true,
        factory: { id: row.id, sal_code: row.sal_code, ownerPlayerId, queuedUnitTypeKey: unitTypeKey, queueProgressFraction: 0 },
      };
    },

    transferFactoryOwnership(lobbyId, salCode, newOwnerPlayerId) {
      updateFactoryOwner.run(newOwnerPlayerId, lobbyId, salCode);
    },

    getFactories(lobbyId) {
      settle(lobbyId);
      const rows = selectFactoriesInLobby.all(lobbyId) as unknown as FactoryRow[];
      return rows.map((row) => toFactoryState(lobbyId, row));
    },
  };
}
