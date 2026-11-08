// Checks server/public/unit-icon.js's UNIT_ARCHETYPE_ICONS map directly —
// a dependency-free module (per its own file comment), same "testable
// without jsdom" convention as unit-visual.test.ts. ANU-053: this map was
// missing an "emp" entry (Record<"drone"|"robot", string>) even after
// unit-visual.js's ARCHETYPE_BY_UNIT_TYPE_KEY learns to resolve "emp" to
// that archetype — without this entry, map.js's
// `UNIT_ARCHETYPE_ICONS[unitGroup.archetype]` would be undefined for an
// emp unit, producing a broken `<image href="undefined">` even once
// unitVisual() stopped throwing.
import { expect, it } from "vitest";
import { UNIT_ARCHETYPE_ICONS, UNIT_MARKER_SIZE } from "../server/public/unit-icon.js";

it("has an icon path for every unit archetype, including emp", () => {
  expect(UNIT_ARCHETYPE_ICONS.drone).toBe("icons/unit-drone.png");
  expect(UNIT_ARCHETYPE_ICONS.robot).toBe("icons/unit-robot.png");
  expect(UNIT_ARCHETYPE_ICONS.emp).toBeDefined();
  expect(typeof UNIT_ARCHETYPE_ICONS.emp).toBe("string");
});

it("the emp marker icon is distinct from drone/robot's, not an accidental reuse", () => {
  expect(UNIT_ARCHETYPE_ICONS.emp).not.toBe(UNIT_ARCHETYPE_ICONS.drone);
  expect(UNIT_ARCHETYPE_ICONS.emp).not.toBe(UNIT_ARCHETYPE_ICONS.robot);
});

it("exports a positive marker size shared by every archetype", () => {
  expect(UNIT_MARKER_SIZE).toBeGreaterThan(0);
});
