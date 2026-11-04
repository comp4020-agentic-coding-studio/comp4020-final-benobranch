// Checks server/public/suburb-detail-view.js's pure suburbDetailViewModel
// output shape for each case issues/ANU-020.md's sidebar bullet lists — not
// a rendered DOM, per CLAUDE.md's current no-manual-e2e rule. Same pattern
// as spec/unit-visual.test.ts/spec/factory-visual.test.ts. (sidebar.js
// itself does document.getElementById at module top level, same as
// map.js/app.js, so it can't be imported outside a real DOM — the pure
// logic lives in suburb-detail-view.js specifically so it can be.)
//
// ANU-022 removed canQueueUnit (a factory auto-produces on a timer, no
// player-picked queue to gate) — these cases now only check canBuildFactory
// and that `factory`/`production` pass through unchanged.
//
// ANU-027 replaced `sendableUnits` (a flat list of the player's own units
// everywhere) with `movableUnitGroups` (the player's own units AT THE
// SELECTED SUBURB ONLY, grouped by type with a count) — the Risk-style
// "Move units" quantity panel's per-row data.
import { expect, it } from "vitest";
import { suburbDetailViewModel } from "../server/public/suburb-detail-view.js";

const ME = "p1";
const THEM = "p2";

const MEMBERS = [
  { playerId: ME, name: "Alice", online: true, color: "#30b319", spawnSalCode: null },
  { playerId: THEM, name: "Bob", online: true, color: "#2419b3", spawnSalCode: null },
];

it("an unowned suburb with no occupants reports a null owner and no actions", () => {
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: {},
    occupancy: [],
    factories: [],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.ownerName).toBeNull();
  expect(detail.ownerColor).toBeNull();
  expect(detail.occupants).toEqual([]);
  expect(detail.factory).toBeNull();
  expect(detail.canBuildFactory).toBe(false);
});

it("a suburb I own with no factory offers canBuildFactory", () => {
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: { "80001-0": ME },
    occupancy: [],
    factories: [],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.ownerName).toBe("Alice");
  expect(detail.ownerColor).toBe("#30b319");
  expect(detail.canBuildFactory).toBe(true);
});

it("a suburb I own with my own factory does not offer canBuildFactory, and its production cycles pass through unchanged", () => {
  const factory = { id: "f1", sal_code: "80001-0", ownerPlayerId: ME, production: [{ unitTypeKey: "drone", progressFraction: 0 }] };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: { "80001-0": ME },
    occupancy: [],
    factories: [factory],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.canBuildFactory).toBe(false);
  expect(detail.factory).toEqual(factory);
});

it("an enemy-owned suburb with an enemy factory offers no build action to me", () => {
  const factory = { id: "f1", sal_code: "80001-0", ownerPlayerId: THEM, production: [] };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: { "80001-0": THEM },
    occupancy: [],
    factories: [factory],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.ownerName).toBe("Bob");
  expect(detail.canBuildFactory).toBe(false);
});

it("movableUnitGroups is filtered to the selected suburb and the viewing player's own units, grouped by type with a count", () => {
  const myDrone1 = { id: "u1", ownerPlayerId: ME, sal_code: "80001-0", unitTypeKey: "drone", health: 3 };
  const myDrone2 = { id: "u2", ownerPlayerId: ME, sal_code: "80001-0", unitTypeKey: "drone", health: 3 };
  const myRobot = { id: "u3", ownerPlayerId: ME, sal_code: "80001-0", unitTypeKey: "robot", health: 6 };
  const theirUnit = { id: "u4", ownerPlayerId: THEM, sal_code: "80001-0", unitTypeKey: "robot", health: 6 };
  const myUnitElsewhere = { id: "u5", ownerPlayerId: ME, sal_code: "80002-0", unitTypeKey: "drone", health: 3 };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: {},
    occupancy: [myDrone1, myDrone2, myRobot, theirUnit, myUnitElsewhere],
    factories: [],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.movableUnitGroups).toEqual(
    expect.arrayContaining([
      { unitTypeKey: "drone", count: 2 },
      { unitTypeKey: "robot", count: 1 },
    ]),
  );
  expect(detail.movableUnitGroups).toHaveLength(2);
});

it("movableUnitGroups is empty when the player has no units at the selected suburb", () => {
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: {},
    occupancy: [],
    factories: [],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.movableUnitGroups).toEqual([]);
});

it("occupants lists every unit standing in the selected suburb specifically, regardless of owner", () => {
  const here1 = { id: "u1", ownerPlayerId: ME, sal_code: "80001-0", unitTypeKey: "drone", health: 3 };
  const here2 = { id: "u2", ownerPlayerId: THEM, sal_code: "80001-0", unitTypeKey: "robot", health: 6 };
  const elsewhere = { id: "u3", ownerPlayerId: ME, sal_code: "80002-0", unitTypeKey: "drone", health: 3 };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: {},
    occupancy: [here1, here2, elsewhere],
    factories: [],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.occupants).toEqual([here1, here2]);
});
