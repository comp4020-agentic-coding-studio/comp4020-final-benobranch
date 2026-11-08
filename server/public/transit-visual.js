// @ts-check
// Pure function (ANU-038) — groups in-transit occupant units into the
// per-(origin, destination, owner, archetype) clusters renderTransit
// (map.js) draws as a single dotted arrow, same "testable without jsdom"
// convention as unit-marker-layout.js's layoutUnitMarkers (which this
// mirrors closely: both turn a flat OccupantUnit[] into drawable groups, one
// for grounded markers fanned out at a single suburb, this one for airborne/
// mid-hop markers travelling between two). No DOM/geometry access — map.js
// resolves each unit's archetype via unit-visual.js first and turns the
// groups this returns into actual SVG line/icon elements positioned along
// the real origin/destination label_points.

/**
 * @typedef {object} ResolvedTransitUnit
 * @property {string} id
 * @property {string} sal_code - the ORIGIN suburb (OccupantUnit.sal_code stays the origin for the whole trip — see server/protocol.ts).
 * @property {string} destinationSalCode
 * @property {number} travelProgressFraction
 * @property {string} ownerPlayerId
 * @property {"drone" | "robot" | "emp"} archetype
 */

/**
 * @typedef {object} TransitGroup
 * @property {string} sal_code - origin
 * @property {string} destinationSalCode
 * @property {string} ownerPlayerId
 * @property {"drone" | "robot" | "emp"} archetype
 * @property {number} count
 * @property {number} travelProgressFraction - the group's progress mark position; the LEAST advanced member's fraction, so a trailing straggler never looks like it has already passed the mark the group's dot sits at.
 * @property {string} sampleUnitId - one representative unit id from the group, for map click selection, same convention as unit-marker-layout.js's UnitMarkerGroup.
 */

/** @param {string} sal_code @param {string} destinationSalCode @param {string} ownerPlayerId @param {"drone" | "robot" | "emp"} archetype */
function groupKey(sal_code, destinationSalCode, ownerPlayerId, archetype) {
  return `${sal_code}|${destinationSalCode}|${ownerPlayerId}|${archetype}`;
}

/**
 * @param {ResolvedTransitUnit[]} units - already filtered to in-transit units only (map.js does this via unit-visual.js's state === "in-transit").
 * @returns {TransitGroup[]}
 */
export function layoutTransitArrows(units) {
  /** @type {Map<string, TransitGroup>} */
  const byKey = new Map();
  for (const unit of units) {
    const key = groupKey(unit.sal_code, unit.destinationSalCode, unit.ownerPlayerId, unit.archetype);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.travelProgressFraction = Math.min(existing.travelProgressFraction, unit.travelProgressFraction);
    } else {
      byKey.set(key, {
        sal_code: unit.sal_code,
        destinationSalCode: unit.destinationSalCode,
        ownerPlayerId: unit.ownerPlayerId,
        archetype: unit.archetype,
        count: 1,
        travelProgressFraction: unit.travelProgressFraction,
        sampleUnitId: unit.id,
      });
    }
  }

  // Stable order (same sort keys as unit-marker-layout.js's bucket sort)
  // purely so redraws don't reorder DOM children for no reason — arrows
  // don't fan out/overlap the way grounded markers at one suburb do, so
  // there's no layout reason to sort, only redraw-stability.
  return [...byKey.values()].sort((a, b) =>
    a.sal_code === b.sal_code
      ? a.destinationSalCode === b.destinationSalCode
        ? a.ownerPlayerId === b.ownerPlayerId
          ? a.archetype.localeCompare(b.archetype)
          : a.ownerPlayerId.localeCompare(b.ownerPlayerId)
        : a.destinationSalCode.localeCompare(b.destinationSalCode)
      : a.sal_code.localeCompare(b.sal_code),
  );
}
