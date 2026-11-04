// Checks server/public/capture-visual.js's zoneVisual() pure function
// against the four exact cases issues/ANU-017.md's user quote describes —
// asserting specific fill/stripes/pulsing/progress values, not just
// "non-null" — since CLAUDE.md's current cost-discipline rule means this
// can't be verified by manually driving a browser. Same pattern as
// spec/unit-visual.test.ts/spec/factory-visual.test.ts.
import { expect, it } from "vitest";
import { zoneVisual } from "../server/public/capture-visual.js";

const colorByPlayerId = new Map([
  ["owner-1", "#30b319"],
  ["capturer-1", "#2419b3"],
  ["contester-1", "#b31942"],
  ["contester-2", "#7519b3"],
]);

it("case 1: owned, no capture in progress — plain fill, no stripes, no progress", () => {
  const visual = zoneVisual({ ownerPlayerId: "owner-1", capture: null, colorByPlayerId });
  expect(visual).toEqual({ fill: { color: "#30b319", opacity: 0.45 }, stripes: [], progress: null });
});

it("case 1 (neutral variant): no owner, no capture — null fill, no stripes, no progress", () => {
  const visual = zoneVisual({ ownerPlayerId: null, capture: null, colorByPlayerId });
  expect(visual).toEqual({ fill: null, stripes: [], progress: null });
});

it("case 2: neutral zone, one player capturing, uncontested — null fill, one non-pulsing stripe, real progress", () => {
  const visual = zoneVisual({
    ownerPlayerId: null,
    capture: { capturingPlayerId: "capturer-1", contestingPlayerIds: [], progressFraction: 0.37 },
    colorByPlayerId,
  });
  expect(visual).toEqual({
    fill: null,
    stripes: [{ color: "#2419b3", pulsing: false }],
    progress: 0.37,
  });
});

it("case 3: neutral zone, two players present, one already capturing when the other enters — two non-overlapping stripes, only the invader pulses", () => {
  const visual = zoneVisual({
    ownerPlayerId: null,
    capture: { capturingPlayerId: "capturer-1", contestingPlayerIds: ["contester-1"], progressFraction: 0.5 },
    colorByPlayerId,
  });
  expect(visual.fill).toBeNull();
  expect(visual.progress).toBe(0.5);
  expect(visual.stripes).toEqual([
    { color: "#2419b3", pulsing: false },
    { color: "#b31942", pulsing: true },
  ]);
});

it("case 3 (generalized, confirmed with the user): 3+ players present — every contester pulses, the original capturer does not", () => {
  const visual = zoneVisual({
    ownerPlayerId: null,
    capture: { capturingPlayerId: "capturer-1", contestingPlayerIds: ["contester-1", "contester-2"], progressFraction: 0.2 },
    colorByPlayerId,
  });
  expect(visual.stripes).toEqual([
    { color: "#2419b3", pulsing: false },
    { color: "#b31942", pulsing: true },
    { color: "#7519b3", pulsing: true },
  ]);
});

it("case 4: a player owns the zone and another is invading it — owner's fill stays, only the invader's stripe shows, pulsing", () => {
  const visual = zoneVisual({
    ownerPlayerId: "owner-1",
    capture: { capturingPlayerId: "capturer-1", contestingPlayerIds: [], progressFraction: 0.1 },
    colorByPlayerId,
  });
  expect(visual).toEqual({
    fill: { color: "#30b319", opacity: 0.45 },
    stripes: [{ color: "#2419b3", pulsing: true }],
    progress: 0.1,
  });
});

it("case 4 (multiple invaders of an owned zone): owner's fill stays, every invader's stripe pulses, none belongs to the owner", () => {
  const visual = zoneVisual({
    ownerPlayerId: "owner-1",
    capture: { capturingPlayerId: "capturer-1", contestingPlayerIds: ["contester-1"], progressFraction: 0.6 },
    colorByPlayerId,
  });
  expect(visual.fill).toEqual({ color: "#30b319", opacity: 0.45 });
  expect(visual.stripes).toEqual([
    { color: "#2419b3", pulsing: true },
    { color: "#b31942", pulsing: true },
  ]);
  expect(visual.stripes.some((s) => s.color === "#30b319")).toBe(false);
});

it("an unknown player id falls back to a neutral grey rather than throwing", () => {
  const visual = zoneVisual({
    ownerPlayerId: null,
    capture: { capturingPlayerId: "ghost-player", contestingPlayerIds: [], progressFraction: 0.1 },
    colorByPlayerId,
  });
  expect(visual.stripes[0].color).toBe("#888");
});
