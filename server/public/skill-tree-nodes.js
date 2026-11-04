// @ts-check
// Static skill-tree node definitions (ANU-016) — the single source of truth
// for tree *structure* (id, prerequisite, TFLOPS cost, display icon), shared
// between server/skill-tree.ts (purchase/validation logic, which also keeps
// its own server-only map of exact perk values — see PERK_EFFECTS there) and
// the client-side skill-tree-visual.js pure function. Plain JS, not .ts, so
// the browser can load it directly with no bundler — same constraint
// app.js/map.js/unit-visual.js/factory-visual.js are already built around.
// server/skill-tree.ts (a .ts file) can import this .js file fine
// (tsconfig's `allowJs`); the reverse (client importing a .ts file) isn't
// possible, which is why this data lives here rather than in skill-tree.ts.
/**
 * @typedef {object} SkillNodeDef
 * @property {string} id
 * @property {string | null} prerequisiteId - another node's id, or null for
 *   a root node. A player must have already unlocked this before `id` is
 *   purchasable (see skill-tree-visual.js's `purchasable`).
 * @property {number} costTflops
 * @property {"perk" | "structural"} effectKind - "perk" nodes set one of
 *   server/perks.ts's named multipliers (see skill-tree.ts's PERK_EFFECTS
 *   for the exact key/value); "structural" nodes have no multiplier effect
 *   of their own — either a tech prerequisite gating a later node
 *   (drone-chassis/robot-chassis), or a node whose own id gates building a
 *   matching skill-tree unit_types row (advanced-drone/advanced-robot — see
 *   server/skill-tree.ts's seedSkillGatedUnitTypes).
 * @property {string} icon
 */

// drone-chassis/robot-chassis are deliberately pure tech gates with no perk
// effect of their own — issues/ANU-016.md's "tree **structure**, not just a
// flat unlock list" bullet asks for a real prerequisite edge (so an
// advanced-unit purchase can't be a single one-node shop entry), and these
// are that edge: cheaper than the variant they gate (10 vs 15 TFLOPS) so the
// tree has a real early/late-game cost shape, not two same-priced choices.
/** @type {SkillNodeDef[]} */
export const SKILL_NODES = [
  { id: "drone-chassis", prerequisiteId: null, costTflops: 10, effectKind: "structural", icon: "drone" },
  { id: "advanced-drone", prerequisiteId: "drone-chassis", costTflops: 15, effectKind: "structural", icon: "drone" },
  { id: "robot-chassis", prerequisiteId: null, costTflops: 10, effectKind: "structural", icon: "robot" },
  { id: "advanced-robot", prerequisiteId: "robot-chassis", costTflops: 15, effectKind: "structural", icon: "robot" },
  { id: "better-fabs", prerequisiteId: null, costTflops: 10, effectKind: "perk", icon: "factory" },
  { id: "lean-production", prerequisiteId: null, costTflops: 10, effectKind: "perk", icon: "factory" },
  { id: "salvage-training", prerequisiteId: null, costTflops: 10, effectKind: "perk", icon: "scrap" },
  { id: "rapid-capture", prerequisiteId: null, costTflops: 10, effectKind: "perk", icon: "capture" },
  // dataTransferSpeedMultiplier: no consumer yet (PLAN.md's disconnected/
  // connected TFLOPS-flow mechanic isn't implemented by any current issue) —
  // purchasable and wired into the perk hook/schema, effect left as an
  // explicit note for whichever future issue implements TFLOPS flow
  // (issues/ANU-016.md's Done-when).
  { id: "data-uplink", prerequisiteId: null, costTflops: 10, effectKind: "perk", icon: "uplink" },
];
