// @ts-check
// Map-drawable, not yet player-controllable (ANU-014/ANU-013's GUI
// boundary — see issues/ANU-013.md Notes): a pure function from occupancy
// data to a drawable shape. No control here triggers an action; that
// stays protocol-only until all four ANU-013-downstream systems land.
// Plain JS (browsers can't run TypeScript, no bundler) typed against
// server/protocol.ts via JSDoc, same pattern as app.js/map.js.
/** @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit */

/**
 * @typedef {object} UnitVisual
 * @property {"drone" | "robot"} icon - distinct per archetype, not just a
 *   color swap — color is reserved for ownership (issues/ANU-013.md).
 * @property {"grounded" | "in-transit"} state
 * @property {number} healthFraction - 0 (destroyed) to 1 (full health);
 *   callers fade/remove the unit once this reaches 0 rather than this
 *   function doing the removal itself (it has no notion of "remove").
 */

/**
 * unitTypeKey -> archetype icon. Covers the base roster (server/units.ts's
 * seedBaseUnitTypes) and ANU-016's skill-tree-gated "mk2" variants
 * (server/skill-tree.ts's seedSkillGatedUnitTypes) — an advanced variant is
 * a stat upgrade on the same chassis, not a new archetype, so it renders
 * with the same icon as its base unit rather than needing its own.
 * @type {Record<string, "drone" | "robot">}
 */
const ARCHETYPE_BY_UNIT_TYPE_KEY = {
  drone: "drone",
  "drone-mk2": "drone",
  robot: "robot",
  "robot-mk2": "robot",
};

/**
 * @param {OccupantUnit} unit
 * @param {number} maxHealth - the unit type's base health (server/units.ts
 *   seedBaseUnitTypes), needed since OccupantUnit only carries current
 *   health, not max.
 * @returns {UnitVisual}
 */
export function unitVisual(unit, maxHealth) {
  const archetype = ARCHETYPE_BY_UNIT_TYPE_KEY[unit.unitTypeKey];
  if (!archetype) {
    throw new Error(`unitVisual: unknown unit type '${unit.unitTypeKey}'`);
  }
  return {
    icon: archetype,
    // ANU-038 gave both archetypes real travel time — a robot's single
    // adjacency hop now takes real time and shows the same in-transit state
    // a drone's flight does (previously this branch was drone-only, back
    // when travel was instant and only a drone's unrestricted "fly" move
    // was ever imagined to need a mid-flight visual at all; see
    // issues/ANU-014.md's original Resolution). destinationSalCode is set
    // for exactly as long as server/units.ts's settleArrivals hasn't yet
    // resolved this unit's dispatch.
    state: unit.destinationSalCode ? "in-transit" : "grounded",
    healthFraction: maxHealth > 0 ? Math.max(0, Math.min(1, unit.health / maxHealth)) : 0,
  };
}
