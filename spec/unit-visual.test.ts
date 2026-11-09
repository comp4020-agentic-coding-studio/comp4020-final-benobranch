// Checks server/public/unit-visual.js's pure function output shape for
// each case issues/ANU-014.md's "GUI representation" bullet lists — not a
// rendered screenshot, per CLAUDE.md's current no-manual-e2e rule.
import { expect, it } from "vitest";
import { unitVisual } from "../server/public/unit-visual.js";

const BASE_UNIT = { id: "u1", ownerPlayerId: "p1", sal_code: "80001-0", health: 3 };

it("distinguishes drone from robot by icon, not just color", () => {
  const drone = unitVisual({ ...BASE_UNIT, unitTypeKey: "drone" }, 3);
  const robot = unitVisual({ ...BASE_UNIT, unitTypeKey: "robot" }, 6);
  expect(drone.icon).toBe("drone");
  expect(robot.icon).toBe("robot");
  expect(drone.icon).not.toBe(robot.icon);
});

it("reports a destroyed unit (health 0) as healthFraction 0", () => {
  const destroyed = unitVisual({ ...BASE_UNIT, unitTypeKey: "robot", health: 0 }, 6);
  expect(destroyed.healthFraction).toBe(0);
});

it("reports full health as healthFraction 1", () => {
  const full = unitVisual({ ...BASE_UNIT, unitTypeKey: "drone", health: 3 }, 3);
  expect(full.healthFraction).toBe(1);
});

it("a drone mid-flight (destinationSalCode set) reports state 'in-transit'", () => {
  const inTransit = unitVisual(
    { ...BASE_UNIT, unitTypeKey: "drone", destinationSalCode: "80002", moveStartedAt: "2026-11-03T00:00:00.000Z" },
    3,
  );
  expect(inTransit.state).toBe("in-transit");
});

it("a unit with no destinationSalCode reports state 'grounded'", () => {
  const grounded = unitVisual({ ...BASE_UNIT, unitTypeKey: "robot" }, 6);
  expect(grounded.state).toBe("grounded");
});

it("a robot also reports 'in-transit' when destinationSalCode is set (ANU-038 gave both archetypes real travel time)", () => {
  const robot = unitVisual(
    { ...BASE_UNIT, unitTypeKey: "robot", destinationSalCode: "80002", moveStartedAt: "2026-11-03T00:00:00.000Z" },
    6,
  );
  expect(robot.state).toBe("in-transit");
});

it("ANU-016's skill-tree-gated 'mk2' variants render with their base archetype's icon, not a new one", () => {
  const advancedDrone = unitVisual({ ...BASE_UNIT, unitTypeKey: "drone-mk2", health: 5 }, 5);
  const advancedRobot = unitVisual({ ...BASE_UNIT, unitTypeKey: "robot-mk2", health: 10 }, 10);
  expect(advancedDrone.icon).toBe("drone");
  expect(advancedRobot.icon).toBe("robot");
});

it("an advanced drone (drone-mk2) mid-flight still reports 'in-transit' like a base drone", () => {
  const inTransit = unitVisual(
    { ...BASE_UNIT, unitTypeKey: "drone-mk2", destinationSalCode: "80002", moveStartedAt: "2026-11-03T00:00:00.000Z" },
    5,
  );
  expect(inTransit.state).toBe("in-transit");
});

// ANU-053: ANU-048 added a real "emp" unit_types row (server/units.ts's
// EMP_UNIT_TYPE_KEY) but ARCHETYPE_BY_UNIT_TYPE_KEY was never updated to
// recognize it — unitVisual() threw for any emp unit, and map.js's
// renderUnits/renderTransit propagated that uncaught (no try/catch at
// either call site), wiping every unit marker on the map the moment one
// emp unit existed in the occupancy list, not just the emp's own marker.
it("resolves an 'emp' unit type without throwing, as its own archetype distinct from drone/robot", () => {
  const emp = unitVisual({ ...BASE_UNIT, unitTypeKey: "emp", health: 1 }, 1);
  expect(emp.icon).toBe("emp");
  expect(emp.icon).not.toBe("drone");
  expect(emp.icon).not.toBe("robot");
});

it("an in-transit emp unit reports state 'in-transit', same as drone/robot", () => {
  const inTransit = unitVisual(
    { ...BASE_UNIT, unitTypeKey: "emp", health: 1, destinationSalCode: "80002", moveStartedAt: "2026-11-03T00:00:00.000Z" },
    1,
  );
  expect(inTransit.state).toBe("in-transit");
});

it("a mix of unit types including an emp doesn't throw for any of them (regression for ANU-053's whole-layer wipeout)", () => {
  const units = [
    { ...BASE_UNIT, id: "d1", unitTypeKey: "drone" },
    { ...BASE_UNIT, id: "e1", unitTypeKey: "emp", health: 1 },
    { ...BASE_UNIT, id: "r1", unitTypeKey: "robot" },
  ];
  const visuals = units.map((u) => unitVisual(u, u.health));
  expect(visuals.map((v) => v.icon)).toEqual(["drone", "emp", "robot"]);
});
