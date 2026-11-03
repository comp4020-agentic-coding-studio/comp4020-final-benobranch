// Narrow per-lobby-member perk/modifier hook (ANU-013) — ANU-016's skill
// tree writes to this, and ANU-015/ANU-014/ANU-017/future TFLOPS-flow code
// reads from it, so no system has to reach into the skill tree's internals
// directly. Exposed only through getPerkMultipliers/setPerkMultiplier below
// (never the raw `lobby_members` perk columns) so a skill-tree purchase sets
// an absolute multiplier value — idempotent, not a running product that
// would double-apply if the same node were (re-)purchased.
import type { DatabaseSync } from "node:sqlite";

export interface PerkMultipliers {
  factoryBuildSpeedMultiplier: number;
  factoryBuildCostMultiplier: number;
  scrapPerKillMultiplier: number;
  captureSpeedMultiplier: number;
  dataTransferSpeedMultiplier: number;
}

export const DEFAULT_PERK_MULTIPLIERS: PerkMultipliers = {
  factoryBuildSpeedMultiplier: 1,
  factoryBuildCostMultiplier: 1,
  scrapPerKillMultiplier: 1,
  captureSpeedMultiplier: 1,
  dataTransferSpeedMultiplier: 1,
};

const PERK_COLUMNS: { key: keyof PerkMultipliers; column: string }[] = [
  { key: "factoryBuildSpeedMultiplier", column: "perk_factory_build_speed_multiplier" },
  { key: "factoryBuildCostMultiplier", column: "perk_factory_build_cost_multiplier" },
  { key: "scrapPerKillMultiplier", column: "perk_scrap_per_kill_multiplier" },
  { key: "captureSpeedMultiplier", column: "perk_capture_speed_multiplier" },
  { key: "dataTransferSpeedMultiplier", column: "perk_data_transfer_speed_multiplier" },
];

export interface PerkHook {
  getPerkMultipliers(lobbyId: string, playerId: string): PerkMultipliers;
  /** Sets one multiplier to an absolute value — a skill-tree node purchase, not a stacking factor. */
  setPerkMultiplier(lobbyId: string, playerId: string, key: keyof PerkMultipliers, value: number): void;
}

export function createPerkHook(db: DatabaseSync): PerkHook {
  const selectPerks = db.prepare(
    `SELECT ${PERK_COLUMNS.map((c) => c.column).join(", ")} FROM lobby_members WHERE lobby_id = ? AND player_id = ?`,
  );
  const updateStatements = new Map(
    PERK_COLUMNS.map(({ key, column }) => [
      key,
      db.prepare(`UPDATE lobby_members SET ${column} = ? WHERE lobby_id = ? AND player_id = ?`),
    ]),
  );

  return {
    getPerkMultipliers(lobbyId, playerId) {
      const row = selectPerks.get(lobbyId, playerId) as Record<string, number> | undefined;
      if (!row) return { ...DEFAULT_PERK_MULTIPLIERS };
      const result = {} as PerkMultipliers;
      for (const { key, column } of PERK_COLUMNS) {
        result[key] = row[column];
      }
      return result;
    },

    setPerkMultiplier(lobbyId, playerId, key, value) {
      const stmt = updateStatements.get(key);
      if (!stmt) throw new Error(`unknown perk multiplier: ${key}`);
      stmt.run(value, lobbyId, playerId);
    },
  };
}
