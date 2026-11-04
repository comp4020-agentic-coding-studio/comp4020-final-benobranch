// Checks server/public/factory-visual.js's pure function output shape
// (issues/ANU-015.md's "GUI representation" bullet, reworked by ANU-022
// from a single queue slot to a per-unit-type `production` array), not a
// rendered screenshot, per CLAUDE.md's current no-manual-e2e rule. Same
// pattern as spec/unit-visual.test.ts.
import { expect, it } from "vitest";
import { factoryVisual } from "../server/public/factory-visual.js";

const BASE_FACTORY = { id: "f1", sal_code: "80001-0", ownerPlayerId: "p1" };

it("passes every unit type's production cycle through unchanged", () => {
  const production = [
    { unitTypeKey: "drone", progressFraction: 0 },
    { unitTypeKey: "robot", progressFraction: 0.42 },
  ];
  const visual = factoryVisual({ ...BASE_FACTORY, production }, "#30b319");
  expect(visual.production).toEqual(production);
  expect(visual.icon).toBe("factory");
});

it("an empty production array (no buildable types) passes through as empty, not null/undefined", () => {
  const visual = factoryVisual({ ...BASE_FACTORY, production: [] }, "#30b319");
  expect(visual.production).toEqual([]);
});

it("carries the owner's color through unchanged, for ownership rendering per issues/ANU-013.md", () => {
  const visual = factoryVisual({ ...BASE_FACTORY, production: [] }, "#b31942");
  expect(visual.ownerColor).toBe("#b31942");
});
