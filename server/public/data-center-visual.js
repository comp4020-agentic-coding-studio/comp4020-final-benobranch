// @ts-check
// Data-center tier -> marker icon/color (ANU-021), pulled out of map.js
// (which does top-level `document.getElementById` and so can't be imported
// outside a DOM) so spec/territory.test.ts can import the color constant
// directly, same reason unit-visual.js/factory-visual.js are their own
// dependency-free modules per issues/ANU-013.md's file-layout convention.
//
// Icons are craftpix's Skillicon #35, one recolor per tier (server/public/
// icons/, license in the asset pack's own License.txt), replacing the old
// solid-color `.dc-marker--*` circles.

/** @type {Record<"mega"|"major"|"standard", string>} */
export const DATA_CENTER_TIER_ICONS = {
  mega: "icons/data-center-mega.png",
  major: "icons/data-center-major.png",
  standard: "icons/data-center-standard.png",
};

// Each icon's dominant (highest-pixel-count) non-transparent color, sampled
// from the PNG itself — spec/territory.test.ts checks this against
// PLAYER_COLORS, same guarantee the old solid-fill circles had, now against
// the icons' actual tint instead of a CSS fill rule.
/** @type {Record<"mega"|"major"|"standard", string>} */
export const DATA_CENTER_TIER_COLORS = {
  mega: "#e6336a",
  major: "#ffda45",
  standard: "#8cffde",
};

// Icon display sizes (in map units) are 2x the old circle markers' radius,
// so the new markers read at roughly the same footprint on the map.
/** @type {Record<"mega"|"major"|"standard", number>} */
export const DATA_CENTER_TIER_MARKER_SIZE = { mega: 900, major: 640, standard: 440 };
