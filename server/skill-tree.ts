// Skill tree (ANU-016), funded by TFLOPS (not scrap — PLAN.md's two-resource
// split, [[ANU-013]]'s Resolution). Per issues/ANU-013.md's file-layout
// convention: server-side logic for this system lives in its own module.
// Node *structure* (id, prerequisite, cost, icon) is shared with the
// client-side skill-tree-visual.js via server/public/skill-tree-nodes.js —
// plain JS so the browser can load it with no bundler (same constraint
// map.js/app.js/unit-visual.js/factory-visual.js are already built around).
// This module adds the server-only piece on top: which purchased node sets
// which perk-hook multiplier (PERK_EFFECTS below), and the purchase/
// validation logic itself.
import type { DatabaseSync } from "node:sqlite";
import { createPerkHook, type PerkMultipliers } from "./perks.ts";
import { nowIso } from "./time.ts";
import { SKILL_NODES, type SkillNodeDef } from "./public/skill-tree-nodes.js";

export { SKILL_NODES };
export type { SkillNodeDef };

/**
 * Which perk-hook multiplier a "perk"-kind node sets, and to what absolute
 * value (setPerkMultiplier is absolute, not stacking — server/perks.ts — so
 * a repeated purchase, already rejected by "already-unlocked" below, could
 * never have double-applied anyway, but the absolute-value contract is what
 * makes a single purchase's effect exact and testable).
 *
 * dataTransferSpeedMultiplier (data-uplink) has no reader yet — PLAN.md's
 * disconnected (air) vs. connected (cable) TFLOPS-flow mechanic isn't
 * implemented by any current or sibling issue (issues/ANU-016.md's Done-when
 * flags this explicitly). The node is purchasable and the multiplier is set
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

export type PurchaseNodeResult =
  | { ok: true; unlockedNodeIds: string[]; multipliers: PerkMultipliers }
  | { ok: false; reason: "unknown-node" | "already-unlocked" | "prerequisite-not-met" | "insufficient-tflops" };

export interface SkillTree {
  purchaseNode(lobbyId: string, playerId: string, nodeId: string): PurchaseNodeResult;
  getUnlockedNodeIds(lobbyId: string, playerId: string): string[];
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

export function createSkillTree(db: DatabaseSync): SkillTree {
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
  // Same WHERE-guarded UPDATE shape as factories.ts's deductScrapIfAffordable
  // and store.ts's startLobby — a single synchronous statement with no
  // `await` between the balance check and the deduction (ADR 0001), so two
  // near-simultaneous purchases against the same TFLOPS balance can't both
  // read "affordable" before either writes.
  const deductTflopsIfAffordable = db.prepare(
    "UPDATE lobby_members SET tflops = tflops - ? WHERE lobby_id = ? AND player_id = ? AND tflops >= ?",
  );

  function unlockedNodeIds(lobbyId: string, playerId: string): string[] {
    return (selectUnlocked.all(lobbyId, playerId) as { nodeId: string }[]).map((r) => r.nodeId);
  }

  return {
    purchaseNode(lobbyId, playerId, nodeId) {
      const def = NODES_BY_ID.get(nodeId);
      if (!def) return { ok: false, reason: "unknown-node" };

      if (selectUnlockedOne.get(lobbyId, playerId, nodeId)) {
        return { ok: false, reason: "already-unlocked" };
      }

      if (def.prerequisiteId !== null && !selectUnlockedOne.get(lobbyId, playerId, def.prerequisiteId)) {
        return { ok: false, reason: "prerequisite-not-met" };
      }

      const result = deductTflopsIfAffordable.run(def.costTflops, lobbyId, playerId, def.costTflops);
      if (result.changes === 0) return { ok: false, reason: "insufficient-tflops" };

      insertUnlock.run(lobbyId, playerId, nodeId, nowIso());

      const effect = PERK_EFFECTS[nodeId];
      if (effect) perks.setPerkMultiplier(lobbyId, playerId, effect.key, effect.value);

      return {
        ok: true,
        unlockedNodeIds: unlockedNodeIds(lobbyId, playerId),
        multipliers: perks.getPerkMultipliers(lobbyId, playerId),
      };
    },

    getUnlockedNodeIds(lobbyId, playerId) {
      return unlockedNodeIds(lobbyId, playerId);
    },
  };
}
