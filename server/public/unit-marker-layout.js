// @ts-check
// Pure function (ANU-034) — groups occupant units into the per-(suburb,
// owner, archetype) clusters renderUnits (map.js) draws as a single marker,
// and tracks whether each cluster lost a member since the last call. No
// DOM/geometry access, same "testable without jsdom" convention as
// capture-visual.js's zoneVisual — map.js resolves each unit's
// archetype/in-transit state via unit-visual.js first (that needs
// unitTypesByKey, module state private to map.js) and turns the groups
// this returns into actual SVG positions/elements.
//
// Previously (ANU-020/ANU-024) renderUnits drew one marker per individual
// unit, every one centered on the suburb's exact label_point coordinate —
// a tile holding both a drone and a robot (or units from two contesting
// owners) stacked its markers exactly on top of each other, hiding all but
// whichever was drawn last.

/**
 * @typedef {object} ResolvedUnit
 * @property {string} id
 * @property {string} sal_code
 * @property {string} ownerPlayerId
 * @property {"drone" | "robot" | "emp"} archetype
 * @property {boolean} inTransit
 */

/**
 * @typedef {object} RawGroup
 * @property {string} sal_code
 * @property {string} ownerPlayerId
 * @property {"drone" | "robot" | "emp"} archetype
 * @property {boolean} inTransit
 * @property {number} count
 * @property {string} sampleUnitId
 */

/**
 * @typedef {object} UnitMarkerGroup
 * @property {string} sal_code
 * @property {string} ownerPlayerId
 * @property {"drone" | "robot" | "emp"} archetype
 * @property {boolean} inTransit - true if any unit in the group is mid-travel (unit-visual.js's "in-transit" state) — both archetypes can report this since ANU-038 gave robots real travel time too.
 * @property {number} count
 * @property {string} sampleUnitId - one representative unit id from the group, for map click selection (a group no longer maps 1:1 to a single OccupantUnit).
 * @property {number} offsetIndex - this group's 0-based position among the groups sharing its suburb, in a stable (ownerPlayerId, then archetype) sort order — map.js fans markers out left-to-right by this.
 * @property {number} groupCountAtSalCode - how many groups (including this one) share this suburb, so map.js can center the whole row on label_point.
 * @property {boolean} lostAUnit - true if `count` is lower than this same (sal_code, ownerPlayerId, archetype) group's count on the previous call — drives the "flash red and jitter" loss feedback.
 */

/** @param {string} sal_code @param {string} ownerPlayerId @param {"drone" | "robot" | "emp"} archetype */
function groupKey(sal_code, ownerPlayerId, archetype) {
  return `${sal_code}|${ownerPlayerId}|${archetype}`;
}

/**
 * @param {ResolvedUnit[]} units
 * @param {Map<string, number>} previousCountByGroupKey - the `nextCountByGroupKey` a prior call returned; read-only here. A key simply absent (never seen, or its group's count previously hit 0 and dropped out) is never treated as a loss — there's no prior marker to flash wiping the last unit of a type off a tile removes the group entirely rather than animating a "0" label.
 * @returns {{ groups: UnitMarkerGroup[], nextCountByGroupKey: Map<string, number> }}
 */
export function layoutUnitMarkers(units, previousCountByGroupKey) {
  /** @type {Map<string, RawGroup>} */
  const byKey = new Map();
  for (const unit of units) {
    const key = groupKey(unit.sal_code, unit.ownerPlayerId, unit.archetype);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      if (unit.inTransit) existing.inTransit = true;
    } else {
      byKey.set(key, {
        sal_code: unit.sal_code,
        ownerPlayerId: unit.ownerPlayerId,
        archetype: unit.archetype,
        inTransit: unit.inTransit,
        count: 1,
        sampleUnitId: unit.id,
      });
    }
  }

  /** @type {Map<string, RawGroup[]>} */
  const bySalCode = new Map();
  for (const group of byKey.values()) {
    const bucket = bySalCode.get(group.sal_code);
    if (bucket) bucket.push(group);
    else bySalCode.set(group.sal_code, [group]);
  }

  /** @type {UnitMarkerGroup[]} */
  const groups = [];
  /** @type {Map<string, number>} */
  const nextCountByGroupKey = new Map();

  for (const bucket of bySalCode.values()) {
    // Stable order so a tile's fan-out layout doesn't reshuffle between
    // redraws when nothing at that suburb actually changed.
    bucket.sort((a, b) =>
      a.ownerPlayerId === b.ownerPlayerId
        ? a.archetype.localeCompare(b.archetype)
        : a.ownerPlayerId.localeCompare(b.ownerPlayerId),
    );
    bucket.forEach((group, offsetIndex) => {
      const key = groupKey(group.sal_code, group.ownerPlayerId, group.archetype);
      const previousCount = previousCountByGroupKey.get(key);
      nextCountByGroupKey.set(key, group.count);
      groups.push({
        ...group,
        offsetIndex,
        groupCountAtSalCode: bucket.length,
        lostAUnit: previousCount !== undefined && group.count < previousCount,
      });
    });
  }

  return { groups, nextCountByGroupKey };
}
