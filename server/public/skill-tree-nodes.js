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
 * @property {string} icon - path (relative to server/public/) of the node's
 *   32x32 pixel-art icon — ANU-029: the "glitch white" set (folder 14) of the
 *   craftpix.net Free Skill 32x32 Icons for Cyberpunk Game pack.
 * @property {string} name - display name for the Research tab (ANU-029).
 * @property {string} description - one-line effect summary for the Research
 *   tab. Kept in sync by hand with server/skill-tree.ts's PERK_EFFECTS
 *   values and seedSkillGatedUnitTypes stats.
 * @property {boolean} effectLive - false while the node's perk multiplier
 *   has no reader anywhere in the server, so the GUI can say so instead of
 *   advertising an effect that doesn't happen (ANU-029). data-uplink: no
 *   TFLOPS-flow mechanic exists (ANU-016's Resolution). rapid-capture:
 *   captureSpeedMultiplier's reader is ANU-017's capture-progress code,
 *   not yet merged — flip to true when it lands.
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
  { id: "drone-chassis", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "structural", icon: "icons/skills/drone-chassis.png", name: "Drone Chassis", description: "Unlocks Advanced Drone research.", effectLive: true },
  { id: "advanced-drone", prerequisiteId: "drone-chassis", baseResearchTimeMs: 45_000, effectKind: "structural", icon: "icons/skills/advanced-drone.png", name: "Advanced Drone", description: "Factories also build Drone Mk2: more health and damage.", effectLive: true },
  { id: "robot-chassis", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "structural", icon: "icons/skills/robot-chassis.png", name: "Robot Chassis", description: "Unlocks Advanced Robot research.", effectLive: true },
  { id: "advanced-robot", prerequisiteId: "robot-chassis", baseResearchTimeMs: 45_000, effectKind: "structural", icon: "icons/skills/advanced-robot.png", name: "Advanced Robot", description: "Factories also build Robot Mk2: more health and damage.", effectLive: true },
  { id: "better-fabs", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "icons/skills/better-fabs.png", name: "Better Fabs", description: "Factories produce units 1.5x faster.", effectLive: true },
  { id: "lean-production", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "icons/skills/lean-production.png", name: "Lean Production", description: "New factories cost half the scrap.", effectLive: true },
  { id: "salvage-training", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "icons/skills/salvage-training.png", name: "Salvage Training", description: "1.5x scrap from every kill.", effectLive: true },
  { id: "rapid-capture", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "icons/skills/rapid-capture.png", name: "Rapid Capture", description: "Capture suburbs 1.5x faster.", effectLive: false },
  // dataTransferSpeedMultiplier: no consumer yet (PLAN.md's disconnected/
  // connected TFLOPS-flow mechanic isn't implemented by any current issue) —
  // researchable and wired into the perk hook/schema, effect left as an
  // explicit note for whichever future issue implements TFLOPS flow
  // (issues/ANU-016.md's Done-when).
  { id: "data-uplink", prerequisiteId: null, baseResearchTimeMs: 30_000, effectKind: "perk", icon: "icons/skills/data-uplink.png", name: "Data Uplink", description: "1.5x data transfer speed for data centers.", effectLive: false },
];
