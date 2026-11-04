// @ts-check
// Map-drawable, not yet player-controllable (ANU-013/ANU-016's GUI boundary
// — see issues/ANU-013.md Notes): a pure function from a player's unlocked
// node set + in-progress research to a drawable shape. No control here
// triggers an action; that stays protocol-only until all four
// ANU-013-downstream systems land. A separate panel from the map itself (a
// skill tree has no map coordinates), so it doesn't integrate into map.js's
// rendering — just an inspectable client-side module, same pattern as
// unit-visual.js/factory-visual.js. Plain JS (browsers can't run
// TypeScript, no bundler).
//
// ANU-019: nodes no longer have a TFLOPS cost (a data center's TFLOPS
// speeds up research, it isn't spent), and only one node can be
// researching at a time (server/skill-tree.ts's one-row-per-player
// skill_research table) — so "purchasable" is no longer an affordability
// check, and a prereq-met node can still be locked if a DIFFERENT node is
// currently being researched.
import { SKILL_NODES } from "./skill-tree-nodes.js";

/** @typedef {import("./skill-tree-nodes.js").SkillNodeDef} SkillNodeDef */
/** @typedef {{ nodeId: string, startedAt: string, progressFraction: number }} ResearchingState */

/**
 * @typedef {object} SkillNodeVisual
 * @property {string} id
 * @property {string} icon
 * @property {boolean} unlocked
 * @property {boolean} researching - this is the one node currently being
 *   researched; carries `progressFraction` from the server's skillTree
 *   message. Mutually exclusive with `unlocked` and `purchasable`.
 * @property {number | null} progressFraction - only non-null when `researching` is true.
 * @property {boolean} purchasable - prerequisite met, not already unlocked,
 *   AND no node (this one or another) is currently being researched — one
 *   active research slot per player. Mutually exclusive with `unlocked` and
 *   `researching`.
 */

/**
 * @param {{ unlockedNodeIds: string[], researching: ResearchingState | null }} playerState
 * @returns {{ nodes: SkillNodeVisual[] }}
 */
export function skillTreeVisual(playerState) {
  const unlocked = new Set(playerState.unlockedNodeIds);
  const researchingNodeId = playerState.researching?.nodeId ?? null;
  const nodes = SKILL_NODES.map((/** @type {SkillNodeDef} */ def) => {
    const isUnlocked = unlocked.has(def.id);
    const isResearching = def.id === researchingNodeId;
    const prerequisiteMet = def.prerequisiteId === null || unlocked.has(def.prerequisiteId);
    return {
      id: def.id,
      icon: def.icon,
      unlocked: isUnlocked,
      researching: isResearching,
      progressFraction: isResearching ? (playerState.researching?.progressFraction ?? 0) : null,
      purchasable: !isUnlocked && !isResearching && prerequisiteMet && researchingNodeId === null,
    };
  });
  return { nodes };
}
