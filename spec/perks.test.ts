// Checks ANU-013's perk/modifier hook in isolation (server/perks.ts),
// against a real SQLite connection via openStore(":memory:") rather than
// over the WebSocket protocol — no message exists yet to exercise this
// (ANU-016's skill tree is what will call setPerkMultiplier for real), so
// the store/DB boundary is what's testable now.
import { expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { DEFAULT_PERK_MULTIPLIERS } from "../server/perks.ts";

it("defaults every multiplier to 1 (no-op) for a lobby member with no perks purchased", () => {
  const store = openStore(":memory:");
  const { playerId } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("perk-defaults", 4, playerId, "perk-tester");

  const multipliers = store.perks.getPerkMultipliers(lobby.lobbyId, playerId);
  expect(multipliers).toEqual(DEFAULT_PERK_MULTIPLIERS);

  store.close();
});

it("setPerkMultiplier sets an absolute value, read back via the same hook (idempotent, not stacking)", () => {
  const store = openStore(":memory:");
  const { playerId } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("perk-set", 4, playerId, "perk-tester");

  store.perks.setPerkMultiplier(lobby.lobbyId, playerId, "factoryBuildSpeedMultiplier", 1.5);
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, playerId).factoryBuildSpeedMultiplier).toBe(1.5);

  // Setting it again to the same value must not double-apply (a purchase
  // re-sent, or a node that can only be bought once, should be idempotent).
  store.perks.setPerkMultiplier(lobby.lobbyId, playerId, "factoryBuildSpeedMultiplier", 1.5);
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, playerId).factoryBuildSpeedMultiplier).toBe(1.5);

  // Other multipliers are unaffected.
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, playerId).scrapPerKillMultiplier).toBe(1);

  store.close();
});

it("perks are scoped per (lobby, player) — one member's purchase doesn't affect another's", () => {
  const store = openStore(":memory:");
  const { playerId: a } = store.resolvePlayer(undefined);
  const { playerId: b } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("perk-scope", 4, a, "player-a");
  store.joinLobby(b, lobby.lobbyId, "player-b");

  store.perks.setPerkMultiplier(lobby.lobbyId, a, "captureSpeedMultiplier", 2);
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, a).captureSpeedMultiplier).toBe(2);
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, b).captureSpeedMultiplier).toBe(1);

  store.close();
});
