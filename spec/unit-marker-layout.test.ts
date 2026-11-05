// Checks server/public/unit-marker-layout.js's layoutUnitMarkers() pure
// function against issues/ANU-034.md's "Done when" bullets: grouping by
// (suburb, owner, archetype) instead of one marker per unit, a stable
// fan-out order/count per suburb, and count-drop ("lostAUnit") detection
// against a caller-supplied previous-count map. Same "no DOM, pure data in/
// shape out" pattern as spec/capture-visual.test.ts/spec/unit-visual.test.ts.
import { expect, it } from "vitest";
import { layoutUnitMarkers } from "../server/public/unit-marker-layout.js";

function unit(overrides: Partial<Parameters<typeof layoutUnitMarkers>[0][number]> = {}) {
  return {
    id: "u1",
    sal_code: "80001-0",
    ownerPlayerId: "p1",
    archetype: "drone" as const,
    inTransit: false,
    ...overrides,
  };
}

it("a single unit at a suburb forms one group of count 1, centered (offsetIndex 0 of 1)", () => {
  const { groups } = layoutUnitMarkers([unit()], new Map());
  expect(groups).toEqual([
    {
      sal_code: "80001-0",
      ownerPlayerId: "p1",
      archetype: "drone",
      inTransit: false,
      count: 1,
      sampleUnitId: "u1",
      offsetIndex: 0,
      groupCountAtSalCode: 1,
      lostAUnit: false,
    },
  ]);
});

it("multiple units of the same owner+archetype at a suburb collapse into one group with the right count", () => {
  const { groups } = layoutUnitMarkers(
    [unit({ id: "u1" }), unit({ id: "u2" }), unit({ id: "u3" })],
    new Map(),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0].count).toBe(3);
});

it("a drone and a robot at the same suburb form two separate, non-overlapping groups", () => {
  const { groups } = layoutUnitMarkers(
    [unit({ id: "u1", archetype: "drone" }), unit({ id: "u2", archetype: "robot" })],
    new Map(),
  );
  expect(groups).toHaveLength(2);
  expect(groups.every((g) => g.groupCountAtSalCode === 2)).toBe(true);
  expect(new Set(groups.map((g) => g.offsetIndex))).toEqual(new Set([0, 1]));
  expect(new Set(groups.map((g) => g.archetype))).toEqual(new Set(["drone", "robot"]));
});

it("two owners' units of the same archetype at a suburb still form two distinct groups, not one merged count", () => {
  const { groups } = layoutUnitMarkers(
    [unit({ id: "u1", ownerPlayerId: "p1" }), unit({ id: "u2", ownerPlayerId: "p2" })],
    new Map(),
  );
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.count)).toEqual([1, 1]);
});

it("group order is stable (sorted by owner then archetype), so a redraw with nothing changed doesn't reshuffle offsets", () => {
  const units = [
    unit({ id: "u1", ownerPlayerId: "p2", archetype: "robot" }),
    unit({ id: "u2", ownerPlayerId: "p1", archetype: "robot" }),
    unit({ id: "u3", ownerPlayerId: "p1", archetype: "drone" }),
  ];
  const { groups: first } = layoutUnitMarkers(units, new Map());
  const { groups: second } = layoutUnitMarkers([...units].reverse(), new Map());
  const keyOf = (g: { ownerPlayerId: string; archetype: string }) => `${g.ownerPlayerId}|${g.archetype}`;
  expect(first.map(keyOf)).toEqual(second.map(keyOf));
  expect(first.map((g) => g.offsetIndex)).toEqual(second.map((g) => g.offsetIndex));
});

it("groups at different suburbs don't affect each other's offsetIndex/groupCountAtSalCode", () => {
  const { groups } = layoutUnitMarkers(
    [unit({ id: "u1", sal_code: "A" }), unit({ id: "u2", sal_code: "B", archetype: "robot" })],
    new Map(),
  );
  expect(groups.find((g) => g.sal_code === "A")?.groupCountAtSalCode).toBe(1);
  expect(groups.find((g) => g.sal_code === "B")?.groupCountAtSalCode).toBe(1);
});

it("inTransit is true for the group if any member unit is in transit", () => {
  const { groups } = layoutUnitMarkers(
    [unit({ id: "u1", inTransit: false }), unit({ id: "u2", inTransit: true })],
    new Map(),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0].inTransit).toBe(true);
});

it("lostAUnit is true when this render's count is lower than the previous render's for the same (suburb, owner, archetype) key", () => {
  const { nextCountByGroupKey } = layoutUnitMarkers(
    [unit({ id: "u1" }), unit({ id: "u2" }), unit({ id: "u3" })],
    new Map(),
  );
  const { groups } = layoutUnitMarkers([unit({ id: "u1" }), unit({ id: "u2" })], nextCountByGroupKey);
  expect(groups[0].count).toBe(2);
  expect(groups[0].lostAUnit).toBe(true);
});

it("lostAUnit is false when the count is unchanged or has grown since the previous render", () => {
  const { nextCountByGroupKey } = layoutUnitMarkers([unit({ id: "u1" })], new Map());
  const unchanged = layoutUnitMarkers([unit({ id: "u1" })], nextCountByGroupKey);
  expect(unchanged.groups[0].lostAUnit).toBe(false);
  const grown = layoutUnitMarkers([unit({ id: "u1" }), unit({ id: "u2" })], nextCountByGroupKey);
  expect(grown.groups[0].lostAUnit).toBe(false);
});

it("lostAUnit is false for a group with no entry in the previous-count map (first time this group has ever been seen)", () => {
  const { groups } = layoutUnitMarkers([unit({ id: "u1" })], new Map());
  expect(groups[0].lostAUnit).toBe(false);
});

it("a group wiped out entirely (count hits 0, unit removed) simply disappears rather than reporting a 0-count group", () => {
  const { nextCountByGroupKey } = layoutUnitMarkers([unit({ id: "u1" })], new Map());
  const { groups } = layoutUnitMarkers([], nextCountByGroupKey);
  expect(groups).toEqual([]);
});

it("nextCountByGroupKey carries forward into a later call unaffected by groups that disappeared in between", () => {
  const first = layoutUnitMarkers([unit({ id: "u1" }), unit({ id: "u2" })], new Map());
  const second = layoutUnitMarkers([], first.nextCountByGroupKey);
  expect(second.groups).toEqual([]);
  // The group came back after being wiped out — since it has no entry in
  // second.nextCountByGroupKey (it was absent from that call's units), its
  // reappearance isn't treated as a loss.
  const third = layoutUnitMarkers([unit({ id: "u3" })], second.nextCountByGroupKey);
  expect(third.groups[0].lostAUnit).toBe(false);
});
