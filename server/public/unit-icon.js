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
//
// ANU-053: "emp" reuses icons/skills/lean-production.png (a lightning-bolt
// glyph) rather than sourcing a new asset — same reuse-not-source precedent
// ANU-048 already set when it picked that file for the "emp-research"
// skill-tree node icon (server/public/skill-tree-nodes.js), and confirmed
// here to be the same 32x32 "glitch" white 6-color palette as
// unit-drone.png/unit-robot.png, so it reads consistently as a unit marker
// too, not just a skill-tree node icon.
/** @type {Record<"drone"|"robot"|"emp", string>} */
export const UNIT_ARCHETYPE_ICONS = {
  drone: "icons/unit-drone.png",
  robot: "icons/unit-robot.png",
  emp: "icons/skills/lean-production.png",
};

// Icon display size (in map units) — same footprint as the old circle
// marker's diameter (r="160" -> 320).
export const UNIT_MARKER_SIZE = 320;
