// @ts-check
// Pure helper (ANU-050) for anchoring a fixed-footprint marker to one
// quadrant around a suburb's label_point, instead of centering it on the
// exact same point every other marker type at that suburb is also centered
// on. Data-center, base and factory markers all shared a suburb's
// label_point with comparable footprints (320-900 map units) to a unit-
// stack marker (map.js's renderUnits, drawn last/topmost in #map-units) —
// centering all of them on the same pixel meant whichever layer painted
// last fully covered the others whenever two marker types shared a suburb,
// which was the routine case, not an edge case (issues/ANU-050.md).
//
// Anchoring a marker so one of ITS OWN corners sits exactly at label_point,
// rather than its center, has two useful properties for this map's layer
// stack:
//  - Two markers anchored to different quadrants (e.g. (-1,-1) and (1,-1))
//    never overlap each other at all, regardless of either marker's size —
//    their bounding boxes only ever meet at label_point itself.
//  - A marker still centered on label_point (map.js keeps the unit-stack
//    marker that way, since it already has its own left-to-right fan-out
//    via layoutUnitMarkers/UNIT_GROUP_GAP for same-suburb unit groups) only
//    overlaps the ONE quadrant-anchored corner nearest it, not the
//    quadrant-anchored marker's full footprint — so a suburb with a data
//    center, base, factory and unit stack all at once still leaves the
//    majority of each non-unit marker's area, and all of the unit marker's
//    area, visible and tappable.
//
// Tradeoff documented in ANU-050's Resolution: the suburb's actual
// label_point now sits at a CORNER, not the center, of each of these three
// marker types — a deliberate "no marker type fully wins" compromise, at
// the cost of a marker's visual center drifting slightly off the suburb's
// true label point. Reordering the `<g>` layers alone (the other candidate
// approach) wouldn't have fixed this: it only changes WHICH marker wins the
// same dead-center pixel, not whether any of them are occluded.
//
// No DOM/geometry access, same "testable without jsdom" convention as
// unit-marker-layout.js/transit-visual.js/capture-visual.js/factory-visual.js.

/**
 * @param {[number, number]} labelPoint
 * @param {number} size - the marker's own footprint (map units) — the same value passed to its width/height attributes
 * @param {-1 | 1} dirX - which horizontal quadrant to anchor into (-1 left, 1 right)
 * @param {-1 | 1} dirY - which vertical quadrant to anchor into (-1 up, 1 down — SVG y increases downward)
 * @returns {[number, number]} the marker's own center point, offset by half its size toward (dirX, dirY)
 */
export function quadrantAnchor([lx, ly], size, dirX, dirY) {
  return [lx + (dirX * size) / 2, ly + (dirY * size) / 2];
}
