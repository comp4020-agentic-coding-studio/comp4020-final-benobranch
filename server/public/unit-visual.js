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
 * @param {OccupantUnit} unit
 * @param {number} maxHealth - the unit type's base health (server/units.ts
 *   seedBaseUnitTypes), needed since OccupantUnit only carries current
 *   health, not max.
 * @returns {UnitVisual}
 */
export function unitVisual(unit, maxHealth) {
  if (unit.unitTypeKey !== "drone" && unit.unitTypeKey !== "robot") {
    throw new Error(`unitVisual: unknown unit type '${unit.unitTypeKey}'`);
  }
  return {
    icon: unit.unitTypeKey,
    // Only a drone can be mid-flight over territory it doesn't own (robots'
    // moves are adjacency-restricted, so they're never airborne between
    // suburbs) — see OccupantUnit's destinationSalCode/moveStartedAt in
    // server/protocol.ts. Nothing sets those fields yet (moves are instant
    // as of this issue; see issues/ANU-014.md Resolution), so every unit
    // currently renders "grounded" in practice — this branch exists for
    // whichever future issue adds travel time.
    state: unit.unitTypeKey === "drone" && unit.destinationSalCode ? "in-transit" : "grounded",
    healthFraction: maxHealth > 0 ? Math.max(0, Math.min(1, unit.health / maxHealth)) : 0,
  };
}
