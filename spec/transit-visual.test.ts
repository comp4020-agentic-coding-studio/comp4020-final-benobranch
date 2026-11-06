// Checks server/public/transit-visual.js's layoutTransitArrows() pure
// function against issues/ANU-038.md's "Done when" grouping bullet: units
// travelling the same (origin, destination, owner, archetype) collapse into
// one dotted-arrow group with a count, same "no DOM, pure data in/shape out"
// pattern as spec/unit-marker-layout.test.ts.
import { expect, it } from "vitest";
import { layoutTransitArrows } from "../server/public/transit-visual.js";

function transitUnit(overrides: Partial<Parameters<typeof layoutTransitArrows>[0][number]> = {}) {
  return {
    id: "u1",
    sal_code: "ORIGIN",
    destinationSalCode: "DEST",
    travelProgressFraction: 0.5,
    ownerPlayerId: "p1",
    archetype: "drone" as const,
    ...overrides,
  };
}

it("a single in-transit unit forms one group of count 1", () => {
  const groups = layoutTransitArrows([transitUnit()]);
  expect(groups).toEqual([
    {
      sal_code: "ORIGIN",
      destinationSalCode: "DEST",
      ownerPlayerId: "p1",
      archetype: "drone",
      count: 1,
      travelProgressFraction: 0.5,
      sampleUnitId: "u1",
    },
  ]);
});

it("multiple units on the same (origin, destination, owner, archetype) trip collapse into one group with the right count", () => {
  const groups = layoutTransitArrows([
    transitUnit({ id: "u1" }),
    transitUnit({ id: "u2" }),
    transitUnit({ id: "u3" }),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].count).toBe(3);
});

it("a group's travelProgressFraction is the LEAST advanced member's, not the most or an average", () => {
  const groups = layoutTransitArrows([
    transitUnit({ id: "u1", travelProgressFraction: 0.8 }),
    transitUnit({ id: "u2", travelProgressFraction: 0.2 }),
    transitUnit({ id: "u3", travelProgressFraction: 0.5 }),
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].travelProgressFraction).toBe(0.2);
});

it("two owners' units on the same route still form two distinct groups, not one merged count", () => {
  const groups = layoutTransitArrows([
    transitUnit({ id: "u1", ownerPlayerId: "p1" }),
    transitUnit({ id: "u2", ownerPlayerId: "p2" }),
  ]);
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.count)).toEqual([1, 1]);
});

it("a drone and a robot on the same route form two separate groups, not one merged count", () => {
  const groups = layoutTransitArrows([
    transitUnit({ id: "u1", archetype: "drone" }),
    transitUnit({ id: "u2", archetype: "robot" }),
  ]);
  expect(groups).toHaveLength(2);
  expect(new Set(groups.map((g) => g.archetype))).toEqual(new Set(["drone", "robot"]));
});

it("units on different routes (same owner/archetype) form separate groups", () => {
  const groups = layoutTransitArrows([
    transitUnit({ id: "u1", sal_code: "A", destinationSalCode: "B" }),
    transitUnit({ id: "u2", sal_code: "C", destinationSalCode: "D" }),
  ]);
  expect(groups).toHaveLength(2);
});

it("an empty input produces no groups", () => {
  expect(layoutTransitArrows([])).toEqual([]);
});

it("group order is stable regardless of input order, so a redraw with nothing changed doesn't reshuffle arrows", () => {
  const units = [
    transitUnit({ id: "u1", ownerPlayerId: "p2", archetype: "robot" }),
    transitUnit({ id: "u2", ownerPlayerId: "p1", archetype: "robot" }),
    transitUnit({ id: "u3", ownerPlayerId: "p1", archetype: "drone" }),
  ];
  const first = layoutTransitArrows(units);
  const second = layoutTransitArrows([...units].reverse());
  const keyOf = (g: { ownerPlayerId: string; archetype: string }) => `${g.ownerPlayerId}|${g.archetype}`;
  expect(first.map(keyOf)).toEqual(second.map(keyOf));
});
