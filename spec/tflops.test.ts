// Checks ANU-019's live TFLOPS: a player's TFLOPS is the sum of the
// data-center suburbs they currently hold (scripts/map/data/map.json's
// data_centers list via server/map-data.ts), recomputed at read time from
// suburb_ownership — no stored balance, no accrual (PLAN.md: a data
// center's TFLOPS rating speeds up skill-tree research, it is not a
// currency, so there's nothing to bank). Exercised by directly importing
// server/tflops.ts against a real in-memory SQLite connection, same pattern
// as spec/perks.test.ts.
import { openStore } from "../server/store.ts";
import { createTerritory } from "../server/territory.ts";
import { createTflopsSource } from "../server/tflops.ts";
import { expect, it } from "vitest";

const MEGA_DATA_CENTER_SAL_CODE = "80038"; // City, 100 TFLOPS (scripts/map/data/map.json)
const STANDARD_DATA_CENTER_SAL_CODE = "80128"; // Uriarra Village, 15 TFLOPS
const NON_DATA_CENTER_SAL_CODE = "80001-0"; // ACT Remainder suburb, no data center

function setup() {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const tflopsSource = createTflopsSource(territory);
  const { playerId } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("tflops-test", 4, playerId, "owner");
  return { store, territory, tflopsSource, lobbyId: lobby.lobbyId, playerId };
}

function setOwner(store: ReturnType<typeof openStore>, lobbyId: string, salCode: string, playerId: string): void {
  store.db
    .prepare(
      "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
    )
    .run(lobbyId, salCode, playerId);
}

it("a player holding no suburbs has 0 TFLOPS", () => {
  const { tflopsSource, lobbyId, playerId } = setup();
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(0);
});

it("a player holding a non-data-center suburb still has 0 TFLOPS", () => {
  const { store, tflopsSource, lobbyId, playerId } = setup();
  setOwner(store, lobbyId, NON_DATA_CENTER_SAL_CODE, playerId);
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(0);
  store.close();
});

it("a player holding one data-center suburb has that data center's exact TFLOPS rating", () => {
  const { store, tflopsSource, lobbyId, playerId } = setup();
  setOwner(store, lobbyId, MEGA_DATA_CENTER_SAL_CODE, playerId);
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(100);
  store.close();
});

it("a player holding several data-center suburbs has their TFLOPS summed", () => {
  const { store, tflopsSource, lobbyId, playerId } = setup();
  setOwner(store, lobbyId, MEGA_DATA_CENTER_SAL_CODE, playerId);
  setOwner(store, lobbyId, STANDARD_DATA_CENTER_SAL_CODE, playerId);
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(115);
  store.close();
});

it("TFLOPS is live — losing a data center (ownership changing to another player) drops it immediately, no stored balance to drain", () => {
  const { store, tflopsSource, lobbyId, playerId } = setup();
  const { playerId: rival } = store.resolvePlayer(undefined);
  store.joinLobby(rival, lobbyId, "rival");

  setOwner(store, lobbyId, MEGA_DATA_CENTER_SAL_CODE, playerId);
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(100);

  setOwner(store, lobbyId, MEGA_DATA_CENTER_SAL_CODE, rival); // capture
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(0);
  expect(tflopsSource.getTflops(lobbyId, rival)).toBe(100);
  store.close();
});

it("TFLOPS is scoped per lobby — holding a data center in one lobby doesn't count in another", () => {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const tflopsSource = createTflopsSource(territory);
  const { playerId } = store.resolvePlayer(undefined);
  const lobbyA = store.createLobby("tflops-scope-a", 4, playerId, "owner-a");
  setOwner(store, lobbyA.lobbyId, MEGA_DATA_CENTER_SAL_CODE, playerId);

  const lobbyB = store.createLobby("tflops-scope-b", 4, playerId, "owner-b");
  expect(tflopsSource.getTflops(lobbyB.lobbyId, playerId)).toBe(0);
  store.close();
});

// --- ANU-048: a blacked-out data center contributes 0 TFLOPS for the duration --- //

it("a data-center suburb under an active EMP blackout contributes 0 TFLOPS to its owner's sum", () => {
  const { store, territory, tflopsSource, lobbyId, playerId } = setup();
  setOwner(store, lobbyId, MEGA_DATA_CENTER_SAL_CODE, playerId);
  setOwner(store, lobbyId, STANDARD_DATA_CENTER_SAL_CODE, playerId);
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(115);

  territory.empStrike(lobbyId, MEGA_DATA_CENTER_SAL_CODE);
  // Only the struck data center is zeroed — the other keeps contributing,
  // proving this is a per-suburb filter, not a blanket "owner is EMP'd" rule.
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(15);
  store.close();
});

it("TFLOPS resumes counting a data center once its EMP blackout expires — no stored balance to unfreeze", () => {
  const { store, territory, tflopsSource, lobbyId, playerId } = setup();
  setOwner(store, lobbyId, MEGA_DATA_CENTER_SAL_CODE, playerId);
  territory.empStrike(lobbyId, MEGA_DATA_CENTER_SAL_CODE);
  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(0);

  // Backdate the strike past EMP_BLACKOUT_DURATION_MS — simulates expiry
  // without a real 20-minute wait.
  store.db
    .prepare("UPDATE suburb_ownership SET emp_started_at = ? WHERE lobby_id = ? AND sal_code = ?")
    .run(new Date(Date.now() - 21 * 60_000).toISOString(), lobbyId, MEGA_DATA_CENTER_SAL_CODE);

  expect(tflopsSource.getTflops(lobbyId, playerId)).toBe(100);
  store.close();
});
