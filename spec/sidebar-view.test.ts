// Checks server/public/suburb-detail-view.js's pure suburbDetailViewModel
// output shape for each case issues/ANU-020.md's sidebar bullet lists — not
// a rendered DOM, per CLAUDE.md's current no-manual-e2e rule. Same pattern
// as spec/unit-visual.test.ts/spec/factory-visual.test.ts. (sidebar.js
// itself does document.getElementById at module top level, same as
// map.js/app.js, so it can't be imported outside a real DOM — the pure
// logic lives in suburb-detail-view.js specifically so it can be.)
import { expect, it } from "vitest";
import { suburbDetailViewModel } from "../server/public/suburb-detail-view.js";

const ME = "p1";
const THEM = "p2";

const MEMBERS = [
  { playerId: ME, name: "Alice", online: true, color: "#30b319" },
  { playerId: THEM, name: "Bob", online: true, color: "#2419b3" },
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
  expect(detail.canQueueUnit).toBe(false);
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
  expect(detail.canQueueUnit).toBe(false);
});

it("a suburb I own with my own idle factory offers canQueueUnit, not canBuildFactory", () => {
  const factory = { id: "f1", sal_code: "80001-0", ownerPlayerId: ME, queuedUnitTypeKey: null, queueProgressFraction: null };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: { "80001-0": ME },
    occupancy: [],
    factories: [factory],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.canBuildFactory).toBe(false);
  expect(detail.canQueueUnit).toBe(true);
  expect(detail.factory).toEqual(factory);
});

it("a suburb I own with my own busy factory does not offer canQueueUnit", () => {
  const factory = { id: "f1", sal_code: "80001-0", ownerPlayerId: ME, queuedUnitTypeKey: "drone", queueProgressFraction: 0.5 };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: { "80001-0": ME },
    occupancy: [],
    factories: [factory],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.canQueueUnit).toBe(false);
});

it("an enemy-owned suburb with an enemy factory offers neither build nor queue action to me", () => {
  const factory = { id: "f1", sal_code: "80001-0", ownerPlayerId: THEM, queuedUnitTypeKey: null, queueProgressFraction: null };
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
  expect(detail.canQueueUnit).toBe(false);
});

it("sendableUnits is filtered to only the viewing player's own units, regardless of suburb", () => {
  const myUnit = { id: "u1", ownerPlayerId: ME, sal_code: "80002-0", unitTypeKey: "drone", health: 3 };
  const theirUnit = { id: "u2", ownerPlayerId: THEM, sal_code: "80003-0", unitTypeKey: "robot", health: 6 };
  const detail = suburbDetailViewModel({
    sal_code: "80001-0",
    ownership: {},
    occupancy: [myUnit, theirUnit],
    factories: [],
    members: MEMBERS,
    myPlayerId: ME,
  });
  expect(detail.sendableUnits).toEqual([myUnit]);
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
