// Checks ANU-016's skill tree: purchasing a node deducts the correct
// TFLOPS and sets the matching perk-hook multiplier to the expected value
// (read back via the same hook ANU-014/ANU-015/ANU-017 read from, proving
// the hook actually changes, not just that a row was written); purchasing a
// node whose prerequisite isn't met is rejected; purchasing twice doesn't
// double-apply the multiplier. Exercised by directly importing
// server/skill-tree.ts against a real in-memory SQLite connection (same
// pattern as spec/factories.test.ts / spec/perks.test.ts) rather than over
// the WebSocket protocol, since TFLOPS balance has no read-back message.
import { expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { createTerritory } from "../server/territory.ts";
import { createUnits } from "../server/units.ts";
import { createFactories } from "../server/factories.ts";
import { createSkillTree } from "../server/skill-tree.ts";
import { DEFAULT_PERK_MULTIPLIERS } from "../server/perks.ts";

function setup() {
  const store = openStore(":memory:");
  const skillTree = createSkillTree(store.db);
  const { playerId } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("skill-tree-test", 4, playerId, "owner");
  return { store, skillTree, lobbyId: lobby.lobbyId, playerId };
}

function giveTflops(store: ReturnType<typeof openStore>, lobbyId: string, playerId: string, amount: number): void {
  store.db.prepare("UPDATE lobby_members SET tflops = tflops + ? WHERE lobby_id = ? AND player_id = ?").run(amount, lobbyId, playerId);
}

it("purchasing a root (no-prerequisite) perk node deducts the correct TFLOPS and sets the matching perk-hook multiplier", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  giveTflops(store, lobbyId, playerId, 20);

  const result = skillTree.purchaseNode(lobbyId, playerId, "better-fabs");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");

  // Read back via the SAME hook server/factories.ts actually reads from —
  // proving the hook's multiplier changed, not just that a skill_nodes row
  // was written.
  expect(store.perks.getPerkMultipliers(lobbyId, playerId).factoryBuildSpeedMultiplier).toBe(1.5);
  expect(result.multipliers.factoryBuildSpeedMultiplier).toBe(1.5);

  const economy = store.getMemberEconomy(lobbyId, playerId)!;
  expect(economy.tflops).toBe(10); // better-fabs costs 10
  store.close();
});

it("every named perk category sets its documented multiplier", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  giveTflops(store, lobbyId, playerId, 1000);

  skillTree.purchaseNode(lobbyId, playerId, "lean-production");
  skillTree.purchaseNode(lobbyId, playerId, "salvage-training");
  skillTree.purchaseNode(lobbyId, playerId, "rapid-capture");
  skillTree.purchaseNode(lobbyId, playerId, "data-uplink");

  const multipliers = store.perks.getPerkMultipliers(lobbyId, playerId);
  expect(multipliers.factoryBuildCostMultiplier).toBe(0.5);
  expect(multipliers.scrapPerKillMultiplier).toBe(1.5);
  expect(multipliers.captureSpeedMultiplier).toBe(1.5);
  // dataTransferSpeedMultiplier has no reader yet (issues/ANU-016.md: TFLOPS
  // flow isn't implemented by any current issue) — only the hook/schema
  // value is checked here, not an effect.
  expect(multipliers.dataTransferSpeedMultiplier).toBe(1.5);
  store.close();
});

it("rejects purchasing a node whose prerequisite isn't met", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  giveTflops(store, lobbyId, playerId, 1000);

  const result = skillTree.purchaseNode(lobbyId, playerId, "advanced-drone");
  expect(result).toEqual({ ok: false, reason: "prerequisite-not-met" });
  store.close();
});

it("purchasing the prerequisite first, then the dependent node, succeeds", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  giveTflops(store, lobbyId, playerId, 1000);

  expect(skillTree.purchaseNode(lobbyId, playerId, "drone-chassis").ok).toBe(true);
  const result = skillTree.purchaseNode(lobbyId, playerId, "advanced-drone");
  expect(result.ok).toBe(true);
  store.close();
});

it("purchasing twice doesn't double-apply the multiplier (rejected as already-unlocked)", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  giveTflops(store, lobbyId, playerId, 1000);

  expect(skillTree.purchaseNode(lobbyId, playerId, "better-fabs").ok).toBe(true);
  const second = skillTree.purchaseNode(lobbyId, playerId, "better-fabs");
  expect(second).toEqual({ ok: false, reason: "already-unlocked" });

  // Multiplier stays at its single-purchase value, not doubled/stacked —
  // setPerkMultiplier is absolute (server/perks.ts), and the purchase is
  // rejected outright before it would even be called again.
  expect(store.perks.getPerkMultipliers(lobbyId, playerId).factoryBuildSpeedMultiplier).toBe(1.5);

  // TFLOPS was only deducted once.
  const economy = store.getMemberEconomy(lobbyId, playerId)!;
  expect(economy.tflops).toBe(990);
  store.close();
});

it("rejects an insufficient TFLOPS balance", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  // No TFLOPS given — better-fabs costs 10.
  const result = skillTree.purchaseNode(lobbyId, playerId, "better-fabs");
  expect(result).toEqual({ ok: false, reason: "insufficient-tflops" });
  store.close();
});

it("rejects an unknown node id", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  giveTflops(store, lobbyId, playerId, 1000);
  const result = skillTree.purchaseNode(lobbyId, playerId, "not-a-real-node");
  expect(result).toEqual({ ok: false, reason: "unknown-node" });
  store.close();
});

it("two near-simultaneous purchases of two different root nodes against a single-node-affordable balance: exactly one succeeds", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  // Exactly enough TFLOPS for ONE 10-cost node, not two.
  giveTflops(store, lobbyId, playerId, 10);

  const resultA = skillTree.purchaseNode(lobbyId, playerId, "better-fabs");
  const resultB = skillTree.purchaseNode(lobbyId, playerId, "lean-production");

  const outcomes = [resultA.ok, resultB.ok];
  expect(outcomes.filter((ok) => ok), "exactly one of the two near-simultaneous purchases should succeed").toHaveLength(1);

  const economy = store.getMemberEconomy(lobbyId, playerId)!;
  expect(economy.tflops, "TFLOPS must not go negative or be double-spent").toBe(0);
  store.close();
});

it("lean-production's factoryBuildCostMultiplier actually halves a drone's build cost through factories.queueUnit, not just a row in the perk table", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  store.startLobby(lobbyId);
  territory.assignSpawnOwnership(lobbyId, [playerId]);
  factories.spawnFactories(lobbyId, [playerId]);
  const factoryId = factories.getFactories(lobbyId)[0].id;
  giveTflops(store, lobbyId, playerId, 1000);
  expect(skillTree.purchaseNode(lobbyId, playerId, "lean-production").ok).toBe(true);

  store.db.prepare("UPDATE lobby_members SET scrap = scrap + 10 WHERE lobby_id = ? AND player_id = ?").run(lobbyId, playerId);
  const result = factories.queueUnit(lobbyId, playerId, factoryId, "drone"); // base cost 2
  expect(result.ok).toBe(true);

  const economy = store.getMemberEconomy(lobbyId, playerId)!;
  expect(economy.scrap, "drone cost (2) at 0.5x should deduct exactly 1, not round back up to 2").toBe(9);
  store.close();
});

it("the advanced-drone node's own unit_types row (seedSkillGatedUnitTypes) is gated by it end-to-end through factories.queueUnit", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  store.startLobby(lobbyId);
  territory.assignSpawnOwnership(lobbyId, [playerId]);
  factories.spawnFactories(lobbyId, [playerId]);
  const factoryId = factories.getFactories(lobbyId)[0].id;
  store.db.prepare("UPDATE lobby_members SET scrap = scrap + 100 WHERE lobby_id = ? AND player_id = ?").run(lobbyId, playerId);
  giveTflops(store, lobbyId, playerId, 1000);

  const lockedAttempt = factories.queueUnit(lobbyId, playerId, factoryId, "drone-mk2");
  expect(lockedAttempt).toEqual({ ok: false, reason: "locked" });

  expect(skillTree.purchaseNode(lobbyId, playerId, "drone-chassis").ok).toBe(true);
  expect(skillTree.purchaseNode(lobbyId, playerId, "advanced-drone").ok).toBe(true);

  const unlockedAttempt = factories.queueUnit(lobbyId, playerId, factoryId, "drone-mk2");
  expect(unlockedAttempt.ok).toBe(true);
  store.close();
});

it("the gated advanced variant's base type (drone) is still buildable without the node, per issues/ANU-016.md's Done-when", () => {
  const { store, lobbyId, playerId } = setup();
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  store.startLobby(lobbyId);
  territory.assignSpawnOwnership(lobbyId, [playerId]);
  factories.spawnFactories(lobbyId, [playerId]);
  const factoryId = factories.getFactories(lobbyId)[0].id;
  store.db.prepare("UPDATE lobby_members SET scrap = scrap + 100 WHERE lobby_id = ? AND player_id = ?").run(lobbyId, playerId);

  const result = factories.queueUnit(lobbyId, playerId, factoryId, "drone");
  expect(result.ok).toBe(true);
  store.close();
});

it("nodes are scoped per (lobby, player) — one member's purchase doesn't affect another's", () => {
  const store = openStore(":memory:");
  const skillTree = createSkillTree(store.db);
  const { playerId: a } = store.resolvePlayer(undefined);
  const { playerId: b } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("skill-tree-scope", 4, a, "player-a");
  store.joinLobby(b, lobby.lobbyId, "player-b");
  giveTflops(store, lobby.lobbyId, a, 20);

  skillTree.purchaseNode(lobby.lobbyId, a, "better-fabs");

  expect(skillTree.getUnlockedNodeIds(lobby.lobbyId, a)).toContain("better-fabs");
  expect(skillTree.getUnlockedNodeIds(lobby.lobbyId, b)).not.toContain("better-fabs");
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, b)).toEqual(DEFAULT_PERK_MULTIPLIERS);
  store.close();
});
