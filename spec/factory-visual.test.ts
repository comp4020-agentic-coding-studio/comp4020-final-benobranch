// Checks server/public/factory-visual.js's pure function output shape for
// queued/idle/mid-build states (issues/ANU-015.md's "GUI representation"
// bullet), not a rendered screenshot, per CLAUDE.md's current no-manual-e2e
// rule. Same pattern as spec/unit-visual.test.ts.
import { expect, it } from "vitest";
import { factoryVisual } from "../server/public/factory-visual.js";

const BASE_FACTORY = { id: "f1", sal_code: "80001-0", ownerPlayerId: "p1" };

it("idle (nothing queued) reports queueProgressFraction null", () => {
  const idle = factoryVisual({ ...BASE_FACTORY, queuedUnitTypeKey: null, queueProgressFraction: null }, "#30b319");
  expect(idle.queueProgressFraction).toBeNull();
  expect(idle.icon).toBe("factory");
});

it("just queued reports queueProgressFraction 0", () => {
  const justQueued = factoryVisual({ ...BASE_FACTORY, queuedUnitTypeKey: "drone", queueProgressFraction: 0 }, "#30b319");
  expect(justQueued.queueProgressFraction).toBe(0);
});

it("mid-build reports the fractional progress unchanged", () => {
  const midBuild = factoryVisual({ ...BASE_FACTORY, queuedUnitTypeKey: "robot", queueProgressFraction: 0.42 }, "#2419b3");
  expect(midBuild.queueProgressFraction).toBe(0.42);
});

it("carries the owner's color through unchanged, for ownership rendering per issues/ANU-013.md", () => {
  const visual = factoryVisual({ ...BASE_FACTORY, queuedUnitTypeKey: null, queueProgressFraction: null }, "#b31942");
  expect(visual.ownerColor).toBe("#b31942");
});
