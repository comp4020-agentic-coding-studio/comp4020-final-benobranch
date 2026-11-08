// Checks ANU-042's auto-fortify redistribution logic directly against
// server/auto-fortify.ts + a real in-memory SQLite connection (same pattern
// as spec/units.test.ts) rather than over the WebSocket protocol — see
// spec/auto-fortify-protocol.test.ts for the setAutoFortifyMode wire-level
// coverage. Every dispatch this module makes goes through the real
// units.moveUnits, so these tests exercise the actual dispatch path, not a
// mock of it.
//
// Fixture geometry (scripts/map/data/map.json, read at module init like
// every other map-fixture spec file): D is the 4-player spawn ring's first
// entry (Giralang, 80063). C/Y/Z (80090/80001-1/80120) form a real
// path-shaped cluster read directly from the map's edges: C's two
// neighbours are Y and Z; Y's other neighbour (80089) and Z's other two
// neighbours (80001-0, 80075) are NOT owned in these tests, so owning
// {C, Y, Z} together makes C landlocked (every neighbour owned) while Y and
// Z are both border territories (each has a non-owned neighbour) — the
// exact "any non-owned neighbour, enemy or unclaimed, counts as border"
// rule confirmed with the user (issues/ANU-042.md's Notes).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { createTerritory } from "../server/territory.ts";
import { createUnits } from "../server/units.ts";
import { createAutoFortify, AUTO_FORTIFY_SURPLUS_THRESHOLD } from "../server/auto-fortify.ts";
import type { AutoFortifyMode } from "../server/store.ts";

interface MapFixture {
  suburbs: { idx: number; sal_code: string; name: string }[];
  edges: { a: number; b: number }[];
  spawn_table_by_lobby_size: Record<string, { spawns: string[] }>;
}

const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as MapFixture;
const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));
const idxToSalCode = new Map(mapData.suburbs.map((s) => [s.idx, s.sal_code]));

const adjacency = new Map<string, Set<string>>();
for (const edge of mapData.edges) {
  const a = idxToSalCode.get(edge.a)!;
  const b = idxToSalCode.get(edge.b)!;
  if (!adjacency.has(a)) adjacency.set(a, new Set());
  if (!adjacency.has(b)) adjacency.set(b, new Set());
  adjacency.get(a)!.add(b);
  adjacency.get(b)!.add(a);
}

const D = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
const C = "80090";
const Y = "80001-1";
const Z = "80120";

// Sanity-check the fixture's real adjacency against the map data, so these
// tests fail loudly (here, not deep in an assertion) if map.json's edges
// around this cluster ever change.
if (!adjacency.get(C)!.has(Y) || !adjacency.get(C)!.has(Z)) {
  throw new Error("fixture assumption broken: C must be adjacent to both Y and Z — check scripts/map/data/map.json");
}
if (adjacency.get(Y)!.has(Z)) {
  throw new Error("fixture assumption broken: Y and Z must not be adjacent to each other");
}

function setup() {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const { playerId: owner } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("auto-fortify-test", 4, owner, "owner");
  store.startLobby(lobby.lobbyId);
  const autoFortify = createAutoFortify(territory, units, (lobbyId, playerId) => store.getAutoFortifyMode(lobbyId, playerId));
  return { store, territory, units, autoFortify, lobbyId: lobby.lobbyId, owner };
}

function grantOwnership(store: ReturnType<typeof openStore>, lobbyId: string, playerId: string, salCodes: string[]): void {
  const upsert = store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  );
  for (const salCode of salCodes) upsert.run(lobbyId, salCode, playerId);
}

function setMode(store: ReturnType<typeof openStore>, lobbyId: string, playerId: string, mode: AutoFortifyMode): void {
  store.setAutoFortifyMode(lobbyId, playerId, mode);
}

/** Grounded (not in-transit) unit count of `unitTypeKey` at `salCode`. */
function groundedCountAt(units: ReturnType<typeof createUnits>, lobbyId: string, salCode: string, unitTypeKey: string): number {
  return units.getOccupancy(lobbyId).filter((u) => u.sal_code === salCode && u.unitTypeKey === unitTypeKey && !u.destinationSalCode).length;
}

/** Count of units of `unitTypeKey` currently in transit TOWARD `salCode`. */
function inTransitToCount(units: ReturnType<typeof createUnits>, lobbyId: string, salCode: string, unitTypeKey: string): number {
  return units.getOccupancy(lobbyId).filter((u) => u.destinationSalCode === salCode && u.unitTypeKey === unitTypeKey).length;
}

it("mode 'off' (the default) never dispatches anything, even with a territory far over threshold", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D, C]);
  for (let i = 0; i < AUTO_FORTIFY_SURPLUS_THRESHOLD * 2; i++) units.placeUnit(lobbyId, owner, D, "drone");

  autoFortify.run(lobbyId, owner); // mode defaults to "off"

  expect(units.getOccupancy(lobbyId).some((u) => u.destinationSalCode)).toBe(false);
  store.close();
});

it("does nothing when the player owns only one territory, regardless of mode or surplus", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D]);
  for (let i = 0; i < AUTO_FORTIFY_SURPLUS_THRESHOLD * 2; i++) units.placeUnit(lobbyId, owner, D, "drone");
  setMode(store, lobbyId, owner, "balance");

  autoFortify.run(lobbyId, owner);

  expect(units.getOccupancy(lobbyId).some((u) => u.destinationSalCode)).toBe(false);
  store.close();
});

it("does nothing when no owned territory is over the surplus threshold", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D, C]);
  for (let i = 0; i < AUTO_FORTIFY_SURPLUS_THRESHOLD; i++) units.placeUnit(lobbyId, owner, D, "drone"); // exactly at, not over, threshold
  setMode(store, lobbyId, owner, "balance");

  autoFortify.run(lobbyId, owner);

  expect(units.getOccupancy(lobbyId).some((u) => u.destinationSalCode)).toBe(false);
  store.close();
});

it("'balance' mode dispatches surplus drones toward under-stocked owned territories, evenly", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D, C, Y, Z]);
  for (let i = 0; i < 12; i++) units.placeUnit(lobbyId, owner, D, "drone"); // 12 at one territory, 0 at the other three
  setMode(store, lobbyId, owner, "balance");

  autoFortify.run(lobbyId, owner);

  // 12 units split across 4 territories targets 3 each — balance mode
  // weights every owned territory equally, so C/Y/Z (currently empty) each
  // get an equal share of the dispatched surplus.
  expect(inTransitToCount(units, lobbyId, C, "drone")).toBe(3);
  expect(inTransitToCount(units, lobbyId, Y, "drone")).toBe(3);
  expect(inTransitToCount(units, lobbyId, Z, "drone")).toBe(3);
  expect(groundedCountAt(units, lobbyId, D, "drone")).toBe(3);
  store.close();
});

it("'border' mode sends proportionally more surplus to border territories (Y, Z) than to the landlocked one (C)", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  // D is the surplus source; C/Y/Z are the redistribution targets, with C
  // landlocked (every neighbour — Y, Z — owned) and Y/Z both border
  // (each has a real non-owned neighbour per the fixture comment above).
  grantOwnership(store, lobbyId, owner, [D, C, Y, Z]);
  for (let i = 0; i < 10; i++) units.placeUnit(lobbyId, owner, D, "drone");
  setMode(store, lobbyId, owner, "border");

  autoFortify.run(lobbyId, owner);

  const toLandlocked = inTransitToCount(units, lobbyId, C, "drone");
  const toBorderY = inTransitToCount(units, lobbyId, Y, "drone");
  const toBorderZ = inTransitToCount(units, lobbyId, Z, "drone");
  expect(toBorderY).toBeGreaterThan(toLandlocked);
  expect(toBorderZ).toBeGreaterThan(toLandlocked);
  expect(toBorderY).toBe(toBorderZ); // both border territories are symmetric in this fixture, so should get equal shares
  store.close();
});

it("keeps archetypes separate: a drone surplus doesn't trigger moving an under-threshold robot garrison at the same territory", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D, C]);
  for (let i = 0; i < 12; i++) units.placeUnit(lobbyId, owner, D, "drone"); // over threshold
  for (let i = 0; i < 2; i++) units.placeUnit(lobbyId, owner, D, "robot"); // well under threshold
  setMode(store, lobbyId, owner, "balance");

  autoFortify.run(lobbyId, owner);

  expect(units.getOccupancy(lobbyId).filter((u) => u.unitTypeKey === "robot").every((u) => u.sal_code === D && !u.destinationSalCode)).toBe(true);
  expect(inTransitToCount(units, lobbyId, C, "drone")).toBeGreaterThan(0);
  store.close();
});

it("counts a player's own already-in-transit units toward their destination's effective garrison, so a second tick doesn't re-dispatch past the target", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D, C]);
  for (let i = 0; i < 12; i++) units.placeUnit(lobbyId, owner, D, "drone");
  setMode(store, lobbyId, owner, "balance");

  autoFortify.run(lobbyId, owner); // first round: dispatches toward C
  const afterFirstRound = inTransitToCount(units, lobbyId, C, "drone");
  expect(afterFirstRound).toBeGreaterThan(0);

  autoFortify.run(lobbyId, owner); // second round, before anything has arrived
  const afterSecondRound = inTransitToCount(units, lobbyId, C, "drone");

  // The in-flight units toward C already count toward C's effective
  // garrison, so a second tick must not double the dispatch — it should
  // leave the in-transit count unchanged (or only top it up slightly if the
  // first round under-corrected), never blow past the balanced target.
  expect(afterSecondRound).toBeLessThanOrEqual(6); // 12 units split across 2 owned territories targets 6 each
  store.close();
});

it("leaves an in-transit unit undisturbed — it's excluded from being re-selected as a source (units.moveUnits only selects grounded units)", () => {
  const { store, units, autoFortify, lobbyId, owner } = setup();
  grantOwnership(store, lobbyId, owner, [D, C]);
  for (let i = 0; i < 12; i++) units.placeUnit(lobbyId, owner, D, "drone");
  setMode(store, lobbyId, owner, "balance");

  autoFortify.run(lobbyId, owner);
  const inTransitIdsAfterFirstRound = units
    .getOccupancy(lobbyId)
    .filter((u) => u.destinationSalCode)
    .map((u) => u.id)
    .sort();
  expect(inTransitIdsAfterFirstRound.length).toBeGreaterThan(0);

  autoFortify.run(lobbyId, owner);
  const inTransitAfterSecondRound = units.getOccupancy(lobbyId).filter((u) => u.destinationSalCode);
  // Every unit already in transit after round one is still in transit
  // (same id, same destination) — it was never a candidate source for round
  // two, since units.moveUnits only ever selects grounded units.
  for (const id of inTransitIdsAfterFirstRound) {
    expect(inTransitAfterSecondRound.some((u) => u.id === id)).toBe(true);
  }
  store.close();
});
