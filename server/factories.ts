// Factory production (ANU-015, reworked by ANU-022), on top of ANU-013's
// `factories` table and ANU-014's `unit_types`/occupancy primitive. Per
// issues/ANU-013.md's file-layout convention: server-side logic for this
// system lives in its own module.
//
// ANU-022 ("I do not want [units] to be created using scrap. I want them to
// be automatically made based on a timer... The scrap should only be for
// building more factories") replaced ANU-015's player-picked, scrap-paid
// single production queue with this: every factory auto-produces EVERY
// buildable unit type concurrently, each on its own independent timer, with
// no player choice and no scrap cost. "Buildable" for a given factory means
// every ungated `unit_types` row, plus any `requires_skill_node`-gated row
// the factory's current owner has unlocked — confirmed with the user via
// AskUserQuestion to be built modular, so a future unit_types row (gated or
// not) starts auto-producing at every factory with no code change here (see
// getBuildableUnitTypes below, which enumerates unit_types rather than
// naming "drone"/"robot").
//
// Two design calls flagged in issues/ANU-013.md's Notes, confirmed with the
// user via AskUserQuestion before ANU-015 (and unchanged by ANU-022):
//   1. A second (and later) factory can be built in ANY suburb the player
//      currently owns — no adjacency-to-an-existing-factory restriction.
//   2. Capturing a suburb TRANSFERS the factory standing in it to the
//      capturing player (including any in-progress production) rather than
//      destroying it — see transferFactoryOwnership, which ANU-017's
//      capture state machine calls once a capture completes.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { validSalCodes } from "./map-data.ts";
import { createPerkHook } from "./perks.ts";
import { elapsedMs, GAME_TIME_SCALE, nowIso } from "./time.ts";
import { EMP_BLACKOUT_DURATION_MS } from "./territory.ts";
import type { Units } from "./units.ts";
import type { FactoryState, FactoryProductionCycle } from "./protocol.ts";

/**
 * Flat scrap cost to build an additional factory (first one per player is
 * free, placed at kickoff — see spawnFactories). Not specified by the
 * user's request beyond "can build more," so a value had to be chosen: set
 * at 5-10x a single base unit's old build cost (drone 2 scrap, robot 4
 * scrap — server/units.ts's seedBaseUnitTypes, before ANU-022 repurposed
 * that column to `scrap_value`) so expanding production capacity is a
 * meaningful economic investment, not a trivial add-on. Scaled by
 * `factoryBuildCostMultiplier` (below) — as of ANU-022 this is the ONLY
 * scrap-spending action left, so the skill-tree node that used to cheapen a
 * unit's build cost now cheapens this instead (issues/ANU-022.md's
 * Resolution; the perk hook's key name is unchanged, only what it scales).
 */
export const FACTORY_BUILD_COST_SCRAP = 20;

export type BuildFactoryResult =
  | { ok: true; factory: FactoryState }
  | { ok: false; reason: "unknown-suburb" | "not-owner" | "already-exists" | "insufficient-scrap" };

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
  /** ANU-017's capture state machine calls this once a capture completes. */
  transferFactoryOwnership(lobbyId: string, salCode: string, newOwnerPlayerId: string): void;
  /** Settles any production cycles that have completed, then returns current state for broadcast. */
  getFactories(lobbyId: string): FactoryState[];
}

interface UnitTypeRow {
  key: string;
  build_time_ms: number;
  requires_skill_node: string | null;
}

interface FactoryRow {
  id: string;
  sal_code: string;
  ownerPlayerId: string;
}

interface ProductionCycleRow {
  cycleStartedAt: string;
  /** ANU-048: non-null for exactly as long as an EMP blackout has this cycle frozen — see settleFactory's freeze/resume handling below. */
  cycleFrozenAt: string | null;
}

export function createFactories(db: DatabaseSync, units: Units): Factories {
  const perks = createPerkHook(db);

  const selectAllUnitTypes = db.prepare(
    "SELECT key, build_time_ms, requires_skill_node FROM unit_types",
  );
  const hasUnlockedNode = db.prepare(
    "SELECT 1 FROM skill_nodes WHERE lobby_id = ? AND player_id = ? AND node_id = ?",
  );
  const insertFactory = db.prepare(
    "INSERT INTO factories (id, lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?, ?)",
  );
  const selectFactoriesInLobby = db.prepare(`
    SELECT id, sal_code, owner_player_id AS ownerPlayerId
    FROM factories WHERE lobby_id = ?
  `);
  const selectFactoryBySuburb = db.prepare("SELECT id FROM factories WHERE lobby_id = ? AND sal_code = ?");
  const selectOwnedSuburbForPlayer = db.prepare(
    "SELECT sal_code AS salCode FROM suburb_ownership WHERE lobby_id = ? AND owner_player_id = ? LIMIT 1",
  );
  const selectSuburbOwner = db.prepare(
    "SELECT owner_player_id AS ownerPlayerId FROM suburb_ownership WHERE lobby_id = ? AND sal_code = ?",
  );
  // ANU-048: reads suburb_ownership's EMP blackout columns directly, same
  // cross-module shared-table read pattern selectOwnedSuburbForPlayer/
  // selectSuburbOwner above (and units.ts's groundCanReach) already use for
  // this table, rather than threading a Territory dependency through
  // createFactories' signature and every existing spec/*.test.ts call site
  // that constructs one.
  const selectEmpStartedAt = db.prepare(
    "SELECT emp_started_at AS empStartedAt FROM suburb_ownership WHERE lobby_id = ? AND sal_code = ?",
  );
  // Same WHERE-guarded UPDATE shape as store.ts's startLobby (`WHERE started
  // = 0`) and units.ts's scrap credit — a single synchronous statement with
  // no `await` between the balance check and the deduction, so two
  // near-simultaneous buildFactory requests against the same balance can't
  // both read "affordable" before either writes (ADR 0001).
  const deductScrapIfAffordable = db.prepare(
    "UPDATE lobby_members SET scrap = scrap - ? WHERE lobby_id = ? AND player_id = ? AND scrap >= ?",
  );
  const updateFactoryOwner = db.prepare("UPDATE factories SET owner_player_id = ? WHERE lobby_id = ? AND sal_code = ?");

  const selectCycle = db.prepare(
    "SELECT cycle_started_at AS cycleStartedAt, cycle_frozen_at AS cycleFrozenAt FROM factory_production WHERE factory_id = ? AND unit_type_key = ?",
  );
  // A factory producing a type for the first time (just built, or a
  // skill-tree node just unlocked a new gated type) has no cycle row yet —
  // lazily create one, started now, rather than requiring every factory x
  // unit-type pairing to be pre-seeded. This is what makes adding a new
  // unit_types row "just work" at every existing factory with no migration.
  const insertCycleIfMissing = db.prepare(
    "INSERT OR IGNORE INTO factory_production (factory_id, unit_type_key, cycle_started_at) VALUES (?, ?, ?)",
  );
  const restartCycle = db.prepare(
    "UPDATE factory_production SET cycle_started_at = ?, cycle_frozen_at = NULL WHERE factory_id = ? AND unit_type_key = ?",
  );
  // ANU-048: freeze/resume a cycle across an EMP blackout — see
  // store.ts's v12 migration comment for why this shifts cycle_started_at
  // forward on resume instead of reusing capture's nullable-started_at/
  // accumulated-ms shape (factory_production.cycle_started_at is NOT NULL).
  const freezeCycle = db.prepare(
    "UPDATE factory_production SET cycle_frozen_at = ? WHERE factory_id = ? AND unit_type_key = ? AND cycle_frozen_at IS NULL",
  );
  const resumeCycle = db.prepare(
    "UPDATE factory_production SET cycle_started_at = ?, cycle_frozen_at = NULL WHERE factory_id = ? AND unit_type_key = ?",
  );

  /** Build-speed-multiplier-adjusted duration a production cycle needs before it completes. */
  function effectiveBuildTimeMs(ownerPlayerId: string, lobbyId: string, baseBuildTimeMs: number): number {
    const speedMultiplier = perks.getPerkMultipliers(lobbyId, ownerPlayerId).factoryBuildSpeedMultiplier;
    const safeSpeedMultiplier = speedMultiplier > 0 ? speedMultiplier : 1; // defend against a malformed perk value dividing by zero
    return baseBuildTimeMs / safeSpeedMultiplier;
  }

  /** Whether `salCode` currently has an unexpired EMP blackout (server/territory.ts's EMP_BLACKOUT_DURATION_MS) — see server/territory.ts's own isEmpActive, duplicated here for the same cross-module-shared-table reason selectEmpStartedAt above gives. */
  function isEmpActive(lobbyId: string, salCode: string): boolean {
    const row = selectEmpStartedAt.get(lobbyId, salCode) as { empStartedAt: string | null } | undefined;
    if (!row?.empStartedAt) return false;
    return elapsedMs(row.empStartedAt) < EMP_BLACKOUT_DURATION_MS;
  }

  /**
   * Every unit_types row a factory owned by `ownerPlayerId` currently
   * auto-produces: every ungated row, plus every `requires_skill_node` row
   * this specific owner has unlocked. Evaluated per-owner (not cached)
   * since unlocks are per-player and a factory's owner can change
   * (transferFactoryOwnership) or gain new unlocks between calls.
   */
  function getBuildableUnitTypes(lobbyId: string, ownerPlayerId: string): UnitTypeRow[] {
    const all = selectAllUnitTypes.all() as unknown as UnitTypeRow[];
    return all.filter(
      (t) => t.requires_skill_node === null || hasUnlockedNode.get(lobbyId, ownerPlayerId, t.requires_skill_node),
    );
  }

  /**
   * Ensures every buildable type at this factory has a cycle row (lazily
   * creating one for any new/newly-unlocked type), then completes any cycle
   * whose (speed-multiplier-adjusted) duration has elapsed: places the
   * resulting unit via units.ts's occupancy primitive at the factory's
   * suburb for the factory's CURRENT owner (not whoever started the cycle
   * — a captured factory's production continues for its new owner, per
   * ANU-015's confirmed capture rule, which ANU-022 keeps), and restarts
   * that type's cycle immediately. Called before every read/broadcast and
   * from index.ts's ~1s ticker — never an armed setTimeout (ADR 0001's
   * stored-timestamp rule).
   *
   * ANU-048: a factory standing on a suburb under an active EMP blackout
   * does not advance or complete ANY cycle — checked first, before the
   * per-type loop, since the blackout is suburb-scoped, not per-type.
   * While blacked out, each buildable type's cycle is frozen (its elapsed
   * progress banked via cycle_frozen_at, see store.ts's v12 migration
   * comment) rather than left to keep silently accruing wall-clock time it
   * was never actually running for; once the blackout lifts, the frozen
   * cycle resumes by shifting cycle_started_at forward by exactly how long
   * it was frozen, so it neither loses progress nor instantly completes.
   */
  function settleFactory(lobbyId: string, factory: FactoryRow): void {
    const buildableTypes = getBuildableUnitTypes(lobbyId, factory.ownerPlayerId);
    const blackedOut = isEmpActive(lobbyId, factory.sal_code);
    for (const unitType of buildableTypes) {
      const cycle = selectCycle.get(factory.id, unitType.key) as ProductionCycleRow | undefined;
      if (!cycle) {
        insertCycleIfMissing.run(factory.id, unitType.key, nowIso());
        continue; // just started this instant — no progress to settle yet
      }

      if (blackedOut) {
        // Bank this instant as the freeze point (no-op if already frozen —
        // freezeCycle's WHERE guard means a later tick while still blacked
        // out doesn't keep pushing the freeze point forward, which would
        // otherwise silently extend how much progress gets banked beyond
        // what had actually accrued when the blackout first took hold).
        freezeCycle.run(nowIso(), factory.id, unitType.key);
        continue; // never completes/restarts while blacked out
      }

      if (cycle.cycleFrozenAt !== null) {
        // The blackout just lifted since the last settle — resume exactly
        // where this cycle left off: shift cycle_started_at forward by how
        // long it sat frozen (REAL ms, not elapsedMs's GAME_TIME_SCALE-
        // scaled value — cycle_started_at is a real wall-clock timestamp,
        // so shifting it must use the same real-time units Date.now()/
        // Date.parse() already return), same "a new started_at set to 'now
        // minus accumulated'" shape backdatedStart gives capture's pause/
        // resume, reached here by shifting the start instead of storing a
        // separate accumulated-ms column (cycle_started_at is NOT NULL —
        // see store.ts's v12 migration comment for why).
        const realFrozenForMs = Date.now() - Date.parse(cycle.cycleFrozenAt);
        const shiftedStartedAt = new Date(Date.parse(cycle.cycleStartedAt) + realFrozenForMs).toISOString();
        resumeCycle.run(shiftedStartedAt, factory.id, unitType.key);
        continue; // re-evaluate completion on the NEXT settle, against the now-correct elapsed time
      }

      const duration = effectiveBuildTimeMs(factory.ownerPlayerId, lobbyId, unitType.build_time_ms);
      if (elapsedMs(cycle.cycleStartedAt) >= duration) {
        units.placeUnit(lobbyId, factory.ownerPlayerId, factory.sal_code, unitType.key);
        restartCycle.run(nowIso(), factory.id, unitType.key);
      }
    }
  }

  function settle(lobbyId: string): void {
    const rows = selectFactoriesInLobby.all(lobbyId) as unknown as FactoryRow[];
    for (const row of rows) settleFactory(lobbyId, row);
  }

  function toFactoryState(lobbyId: string, row: FactoryRow): FactoryState {
    const buildableTypes = getBuildableUnitTypes(lobbyId, row.ownerPlayerId);
    const production: FactoryProductionCycle[] = buildableTypes.map((unitType) => {
      const cycle = selectCycle.get(row.id, unitType.key) as ProductionCycleRow | undefined;
      // settleFactory (called by getFactories before this) inserts a cycle
      // row for every buildable type, so this should always resolve — but
      // degrade to "just started" rather than throw if it somehow doesn't.
      const duration = effectiveBuildTimeMs(row.ownerPlayerId, lobbyId, unitType.build_time_ms);
      // ANU-048: while frozen, elapsedMs(cycle_started_at) must NOT be read
      // directly against "now" — cycle_started_at stays fixed for the whole
      // freeze (it's only ever shifted on RESUME, by settleFactory), so a
      // naive elapsedMs(cycleStartedAt) here would keep climbing with real
      // time even though settleFactory has stopped advancing this cycle,
      // showing progress the blackout is supposed to be holding still.
      // Reading elapsed-as-of-the-freeze-instant instead keeps the
      // displayed fraction pinned at exactly where it was when the freeze
      // took hold, consistent with settleFactory's own freeze/resume logic.
      const elapsed = cycle
        ? cycle.cycleFrozenAt
          ? (Date.parse(cycle.cycleFrozenAt) - Date.parse(cycle.cycleStartedAt)) * GAME_TIME_SCALE
          : elapsedMs(cycle.cycleStartedAt)
        : 0;
      const fraction = cycle ? Math.max(0, Math.min(1, elapsed / duration)) : 0;
      return { unitTypeKey: unitType.key, progressFraction: fraction };
    });
    return { id: row.id, sal_code: row.sal_code, ownerPlayerId: row.ownerPlayerId, production };
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

      const costMultiplier = perks.getPerkMultipliers(lobbyId, ownerPlayerId).factoryBuildCostMultiplier;
      const cost = Math.max(0, Math.round(FACTORY_BUILD_COST_SCRAP * costMultiplier));

      const result = deductScrapIfAffordable.run(cost, lobbyId, ownerPlayerId, cost);
      if (result.changes === 0) return { ok: false, reason: "insufficient-scrap" };

      const id = randomUUID();
      insertFactory.run(id, lobbyId, salCode, ownerPlayerId);
      return { ok: true, factory: toFactoryState(lobbyId, { id, sal_code: salCode, ownerPlayerId }) };
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
