// @ts-check
// Map-drawable, not yet player-controllable (ANU-013/ANU-016's GUI boundary
// — see issues/ANU-013.md Notes): a pure function from a player's unlocked
// node set + TFLOPS balance to a drawable shape. No control here triggers an
// action; that stays protocol-only until all four ANU-013-downstream
// systems land. A separate panel from the map itself (a skill tree has no
// map coordinates), so it doesn't integrate into map.js's rendering — just
// an inspectable client-side module, same pattern as unit-visual.js/
// factory-visual.js. Plain JS (browsers can't run TypeScript, no bundler).
import { SKILL_NODES } from "./skill-tree-nodes.js";

/** @typedef {import("./skill-tree-nodes.js").SkillNodeDef} SkillNodeDef */

/**
 * @typedef {object} SkillNodeVisual
 * @property {string} id
 * @property {string} icon
 * @property {boolean} unlocked
 * @property {boolean} purchasable - prerequisite met AND affordable AND not
 *   already unlocked. Mutually exclusive with `unlocked` (an unlocked node
 *   is never "next-purchasable").
 */

/**
 * @param {{ unlockedNodeIds: string[], tflops: number }} playerState
 * @returns {{ nodes: SkillNodeVisual[] }}
 */
export function skillTreeVisual(playerState) {
  const unlocked = new Set(playerState.unlockedNodeIds);
  const nodes = SKILL_NODES.map((/** @type {SkillNodeDef} */ def) => {
    const isUnlocked = unlocked.has(def.id);
    const prerequisiteMet = def.prerequisiteId === null || unlocked.has(def.prerequisiteId);
    const affordable = playerState.tflops >= def.costTflops;
    return {
      id: def.id,
      icon: def.icon,
      unlocked: isUnlocked,
      purchasable: !isUnlocked && prerequisiteMet && affordable,
    };
  });
  return { nodes };
}
