// @ts-check
// Unit archetype -> marker icon (ANU-024), a dependency-free module (same
// convention as data-center-visual.js) so a plain Node test can import the
// icon paths without needing a DOM.
//
// Icons are craftpix's Skillicon #35-pack glyphs (server/public/icons/,
// license in the asset pack's own License.txt): icon 1 (an eye — aerial
// recon) for drone, icon 26 (a rifle — ground combat) for robot, both the
// "glitch" white color variant (color 14) so the glyph reads the same
// regardless of which player's color backdrop it sits on.
/** @type {Record<"drone"|"robot", string>} */
export const UNIT_ARCHETYPE_ICONS = {
  drone: "icons/unit-drone.png",
  robot: "icons/unit-robot.png",
};

// Icon display size (in map units) — same footprint as the old circle
// marker's diameter (r="160" -> 320).
export const UNIT_MARKER_SIZE = 320;
