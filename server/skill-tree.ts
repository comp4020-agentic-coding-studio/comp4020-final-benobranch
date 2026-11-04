// Skill tree (ANU-016, redesigned by ANU-019 into time-gated research —
// PLAN.md: a data center's TFLOPS rating speeds up unlock rate, it is not a
// currency spent on nodes). Per issues/ANU-013.md's file-layout convention:
// server-side logic for this system lives in its own module. Node
// *structure* (id, prerequisite, base research time, icon) is shared with
// the client-side skill-tree-visual.js via server/public/skill-tree-nodes.js
// — plain JS so the browser can load it with no bundler (same constraint
// map.js/app.js/unit-visual.js/factory-visual.js are already built around).
// This module adds the server-only piece on top: which unlocked node sets
// which perk-hook multiplier (PERK_EFFECTS below), and the research
// start/settle logic itself.
import type { DatabaseSync } from "node:sqlite";
import { createPerkHook, type PerkMultipliers } from "./perks.ts";
import { elapsedMs, nowIso } from "./time.ts";
import type { TflopsSource } from "./tflops.ts";
import { SKILL_NODES, type SkillNodeDef } from "./public/skill-tree-nodes.js";

export { SKILL_NODES };
export type { SkillNodeDef };

/**
 * Which perk-hook multiplier a "perk"-kind node sets, and to what absolute
 * value (setPerkMultiplier is absolute, not stacking — server/perks.ts —
 * which combined with `skill_research`'s one-row-per-player primary key
 * means a node can never complete twice for the same player anyway, but the
 * absolute-value contract is what makes a single completion's effect exact
 * and testable).
 *
 * dataTransferSpeedMultiplier (data-uplink) has no reader yet — PLAN.md's
 * disconnected (air) vs. connected (cable) TFLOPS-flow mechanic isn't
 * implemented by any current or sibling issue (issues/ANU-016.md's Done-when
 * flags this explicitly). The node is researchable and the multiplier is set
 * for real; wiring it to an actual effect is left for whichever future issue
 * implements TFLOPS flow.
 *
 * lean-production's factoryBuildCostMultiplier originally cheapened a
 * queued unit's scrap cost (ANU-015/ANU-016). ANU-022 removed per-unit
 * scrap costs entirely (units auto-produce free, on a timer) and scrap now
 * only funds building a new factory (server/factories.ts's
 * FACTORY_BUILD_COST_SCRAP) — so this multiplier was repointed to scale
 * that instead, keeping the node meaningful without adding a new perk-hook
 * key (issues/ANU-022.md's Resolution). 0.5 halves FACTORY_BUILD_COST_SCRAP
 * (20 -> 10) with no rounding artifact.
 */
const PERK_EFFECTS: Partial<Record<string, { key: keyof PerkMultipliers; value: number }>> = {
  "better-fabs": { key: "factoryBuildSpeedMultiplier", value: 1.5 },
  "lean-production": { key: "factoryBuildCostMultiplier", value: 0.5 },
  "salvage-training": { key: "scrapPerKillMultiplier", value: 1.5 },
  "rapid-capture": { key: "captureSpeedMultiplier", value: 1.5 },
  "data-uplink": { key: "dataTransferSpeedMultiplier", value: 1.5 },
};

const NODES_BY_ID = new Map(SKILL_NODES.map((n) => [n.id, n]));

/**
 * How much a player's current live TFLOPS (server/tflops.ts — the sum of
 * data centers they currently hold) speeds up research: 1x at 0 TFLOPS
 * (research still proceeds at the node's base rate, never blocked for lack
 * of compute — PLAN.md's "speed up the unlock rate," not "gate it"), and
 * +1x per 100 TFLOPS (a single mega data center, PLAN.md's strongest tier,
 * exactly doubles speed on its own). A placeholder curve, same footing as
 * server/skill-tree.ts's other tuning constants — PLAN.md lists the exact
 * TFLOPS-to-research-speed curve as still open.
 */
function speedMultiplier(tflops: number): number {
  return 1 + tflops / 100;
}

export interface ResearchingState {
  nodeId: string;
  startedAt: string;
  /** 0 (just started) to 1 (about to complete) at the player's current TFLOPS-derived speed. */
  progressFraction: number;
}

export interface SkillTreeState {
  unlockedNodeIds: string[];
  /** null when no node is currently being researched — see StartResearchResult's "already-researching" rejection for why there's at most one. */
  researching: ResearchingState | null;
}

export type StartResearchResult =
  | { ok: true; state: SkillTreeState; multipliers: PerkMultipliers }
  | { ok: false; reason: "unknown-node" | "already-unlocked" | "prerequisite-not-met" | "already-researching" };

export interface SkillTree {
  startResearch(lobbyId: string, playerId: string, nodeId: string): StartResearchResult;
  getState(lobbyId: string, playerId: string): SkillTreeState;
}

/**
 * Advanced drone/robot variant rows, upserted idempotently at store boot
 * (same `ON CONFLICT(key) DO UPDATE` pattern as server/units.ts's
 * seedBaseUnitTypes, for the same reason: a migration runs once per schema
 * version, but this issue's gated variants need to exist without forcing
 * their own colliding `PRAGMA user_version` bump). Added as NEW unit_types
 * rows (distinct keys from "drone"/"robot") rather than mutating the base
 * rows in place, so a player without the matching skill node still builds
 * the base version — issues/ANU-016.md's Done-when is explicit about this.
 *
 * Keys are "drone-mk2"/"robot-mk2", not "advanced-drone"/"advanced-robot" —
 * the latter are this module's *node* ids (a separate table/namespace,
 * skill_nodes.node_id), and spec/factories.test.ts already inserts its own
 * throwaway unit_types row literally keyed "advanced-drone" to test the
 * requires_skill_node gate in isolation; reusing that key here would collide
 * with that pre-existing, unrelated test the first time both run against
 * the same boot-seeded connection.
 *
 * Stats: both variants keep their base archetype's movement_mode (gated
 * tech upgrades a chassis, not its movement rule) at 1.5-1.75x the base
 * stat line (health 1.67x for both; damage 1.5x drone, 1.75x robot) — a real
 * upgrade, not a rounding-error difference, while staying below the
 * base-to-base 2x drone/robot ratio ([[ANU-014]]'s Resolution) so "advanced
 * drone" doesn't just become a reskinned robot. The fourth seeded column
 * (`scrap_value`, ANU-022's rename of the old `build_cost_scrap`) no longer
 * gates building this type — it's what destroying one of it credits the
 * killer, scaled up from the base type to match its higher stats.
 */
export function seedSkillGatedUnitTypes(db: DatabaseSync): void {
  const upsert = db.prepare(`
    INSERT INTO unit_types (key, health, damage, scrap_value, build_time_ms, movement_mode, requires_skill_node)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      health = excluded.health,
      damage = excluded.damage,
      scrap_value = excluded.scrap_value,
      build_time_ms = excluded.build_time_ms,
      movement_mode = excluded.movement_mode,
      requires_skill_node = excluded.requires_skill_node
  `);
  upsert.run("drone-mk2", 5, 3, 3, 1500, "fly", "advanced-drone");
  upsert.run("robot-mk2", 10, 7, 7, 3000, "ground", "advanced-robot");
}

interface ResearchRow {
  nodeId: string;
  startedAt: string;
}

export function createSkillTree(db: DatabaseSync, tflopsSource: TflopsSource): SkillTree {
  const perks = createPerkHook(db);

  const selectUnlocked = db.prepare(
    "SELECT node_id AS nodeId FROM skill_nodes WHERE lobby_id = ? AND player_id = ?",
  );
  const selectUnlockedOne = db.prepare(
    "SELECT 1 FROM skill_nodes WHERE lobby_id = ? AND player_id = ? AND node_id = ?",
  );
  const insertUnlock = db.prepare(
    "INSERT INTO skill_nodes (lobby_id, player_id, node_id, unlocked_at) VALUES (?, ?, ?, ?)",
  );
  const selectResearch = db.prepare(
    "SELECT node_id AS nodeId, started_at AS startedAt FROM skill_research WHERE lobby_id = ? AND player_id = ?",
  );
  // Same WHERE-guarded-INSERT concurrency shape ADR 0001's other handlers use
  // (store.ts's startLobby, factories.ts's deductScrapIfAffordable): a
  // single synchronous statement with no `await` between the "is anything
  // already researching" check and the insert, so two near-simultaneous
  // startResearch calls can't both see "nothing in progress" before either
  // writes — the second's INSERT (same lobby_id+player_id primary key)
  // simply fails the uniqueness constraint instead.
  const insertResearch = db.prepare(
    "INSERT INTO skill_research (lobby_id, player_id, node_id, started_at) VALUES (?, ?, ?, ?)",
  );
  const deleteResearch = db.prepare(
    "DELETE FROM skill_research WHERE lobby_id = ? AND player_id = ? AND node_id = ?",
  );

  function unlockedNodeIds(lobbyId: string, playerId: string): string[] {
    return (selectUnlocked.all(lobbyId, playerId) as { nodeId: string }[]).map((r) => r.nodeId);
  }

  /**
   * Completes the player's in-progress research if its (TFLOPS-speed-
   * adjusted) duration has elapsed: unlocks the node, applies its perk
   * effect, and clears the research row. Stored-timestamp settle, same
   * shape as server/factories.ts's settleFactory — called before every
   * state read, never from an armed timer (ADR 0001).
   */
  function settle(lobbyId: string, playerId: string): void {
    const row = selectResearch.get(lobbyId, playerId) as ResearchRow | undefined;
    if (!row) return;
    const def = NODES_BY_ID.get(row.nodeId);
    if (!def) return; // defensive: a node definition was removed since this research started

    const speed = speedMultiplier(tflopsSource.getTflops(lobbyId, playerId));
    const requiredDurationMs = def.baseResearchTimeMs / speed;
    if (elapsedMs(row.startedAt) < requiredDurationMs) return;

    insertUnlock.run(lobbyId, playerId, row.nodeId, nowIso());
    const effect = PERK_EFFECTS[row.nodeId];
    if (effect) perks.setPerkMultiplier(lobbyId, playerId, effect.key, effect.value);
    deleteResearch.run(lobbyId, playerId, row.nodeId);
  }

  function state(lobbyId: string, playerId: string): SkillTreeState {
    settle(lobbyId, playerId);
    const row = selectResearch.get(lobbyId, playerId) as ResearchRow | undefined;
    let researching: ResearchingState | null = null;
    if (row) {
      const def = NODES_BY_ID.get(row.nodeId);
      const speed = speedMultiplier(tflopsSource.getTflops(lobbyId, playerId));
      const requiredDurationMs = def ? def.baseResearchTimeMs / speed : 0;
      const fraction = requiredDurationMs > 0 ? Math.max(0, Math.min(1, elapsedMs(row.startedAt) / requiredDurationMs)) : 0;
      researching = { nodeId: row.nodeId, startedAt: row.startedAt, progressFraction: fraction };
    }
    return { unlockedNodeIds: unlockedNodeIds(lobbyId, playerId), researching };
  }

  return {
    startResearch(lobbyId, playerId, nodeId) {
      const def = NODES_BY_ID.get(nodeId);
      if (!def) return { ok: false, reason: "unknown-node" };

      settle(lobbyId, playerId); // a just-completed research shouldn't block starting the next one

      if (selectUnlockedOne.get(lobbyId, playerId, nodeId)) {
        return { ok: false, reason: "already-unlocked" };
      }

      if (def.prerequisiteId !== null && !selectUnlockedOne.get(lobbyId, playerId, def.prerequisiteId)) {
        return { ok: false, reason: "prerequisite-not-met" };
      }

      if (selectResearch.get(lobbyId, playerId)) {
        return { ok: false, reason: "already-researching" };
      }

      insertResearch.run(lobbyId, playerId, nodeId, nowIso());

      return {
        ok: true,
        state: state(lobbyId, playerId),
        multipliers: perks.getPerkMultipliers(lobbyId, playerId),
      };
    },

    getState(lobbyId, playerId) {
      return state(lobbyId, playerId);
    },
  };
}
