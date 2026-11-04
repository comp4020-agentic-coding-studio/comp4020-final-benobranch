// @ts-check
// Static skill-tree node definitions (ANU-016, time-gated by ANU-019) — the
// single source of truth for tree *structure* (id, prerequisite, base
// research time, display icon), shared between server/skill-tree.ts
// (research/validation logic, which also keeps its own server-only map of
// exact perk values — see PERK_EFFECTS there) and the client-side
// skill-tree-visual.js pure function. Plain JS, not .ts, so the browser can
// load it directly with no bundler — same constraint
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
 * @property {number} baseResearchTimeMs - time to unlock at a 1x TFLOPS
 *   speed multiplier (no data centers held) — see server/skill-tree.ts's
 *   speedMultiplier, which a player's live TFLOPS (server/tflops.ts)
 *   divides this by. Not a cost: research starts for free and always
 *   completes eventually, just faster with more compute.
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
// advanced-unit unlock can't be a single one-node shop entry), and these
// are that edge: shorter than the variant they gate (30s vs 45s at 1x) so
// the tree has a real early/late-game time shape, not two
// same-duration choices. Placeholder numbers — PLAN.md lists the exact
// TFLOPS-to-research-speed curve as still open — scaled 1:1 from ANU-016's
// old costTflops values (10/15) x3000ms, kept only as a starting point.
/** @type {SkillNodeDef[]} */
export const SKILL_NODES = [
  { id: "drone-chassis", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "structural", icon: "drone" },
  { id: "advanced-drone", prerequisiteId: "drone-chassis", baseResearchTimeMs: 45_000, effectKind: "structural", icon: "drone" },
  { id: "robot-chassis", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "structural", icon: "robot" },
  { id: "advanced-robot", prerequisiteId: "robot-chassis", baseResearchTimeMs: 45_000, effectKind: "structural", icon: "robot" },
  { id: "better-fabs", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "factory" },
  { id: "lean-production", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "factory" },
  { id: "salvage-training", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "scrap" },
  { id: "rapid-capture", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "capture" },
  // dataTransferSpeedMultiplier: no consumer yet (PLAN.md's disconnected/
  // connected TFLOPS-flow mechanic isn't implemented by any current issue) —
  // researchable and wired into the perk hook/schema, effect left as an
  // explicit note for whichever future issue implements TFLOPS flow
  // (issues/ANU-016.md's Done-when).
  { id: "data-uplink", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "uplink" },
];
