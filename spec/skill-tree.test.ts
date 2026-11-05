// Checks ANU-016's skill tree as redesigned by ANU-019: researching a node
// is free to start (no TFLOPS cost) and completes once its base research
// time, divided by the player's current live-TFLOPS speed multiplier
// (server/tflops.ts — the sum of data centers they currently hold), has
// elapsed; completing sets the matching perk-hook multiplier (read back via
// the same hook ANU-014/ANU-015/ANU-017 read from, proving the hook
// actually changes, not just that a row was written); starting research on
// a node whose prerequisite isn't met is rejected, as is starting a second
// research while one is already in progress. Exercised by directly
// importing server/skill-tree.ts against a real in-memory SQLite connection
// (same pattern as spec/factories.test.ts / spec/perks.test.ts) rather than
// over the WebSocket protocol — see spec/skill-tree-protocol.test.ts for the
// wire-level coverage.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { createTerritory } from "../server/territory.ts";
import { createUnits } from "../server/units.ts";
import { createFactories, FACTORY_BUILD_COST_SCRAP } from "../server/factories.ts";
import { createTflopsSource } from "../server/tflops.ts";
import { createSkillTree, speedMultiplier } from "../server/skill-tree.ts";
import { DEFAULT_PERK_MULTIPLIERS } from "../server/perks.ts";

const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as { suburbs: { sal_code: string }[] };

// A real mega data center (100 TFLOPS — scripts/map/data/map.json), not a
// throwaway sal_code, so speed-multiplier tests exercise the actual
// map-data -> tflops.ts path rather than a fabricated number.
const MEGA_DATA_CENTER_SAL_CODE = "80038"; // City

function setup() {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const tflopsSource = createTflopsSource(territory);
  const skillTree = createSkillTree(store.db, tflopsSource);
  const { playerId } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("skill-tree-test", 4, playerId, "owner");
  return { store, territory, skillTree, lobbyId: lobby.lobbyId, playerId };
}

/** Grants a player a data-center suburb directly, so their live TFLOPS (server/tflops.ts) is non-zero without going through territory capture. */
function giveDataCenter(store: ReturnType<typeof openStore>, lobbyId: string, playerId: string, salCode: string): void {
  store.db
    .prepare(
      "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
    )
    .run(lobbyId, salCode, playerId);
}

/** Pushes a skill_research row's stored started_at into the past, so it reads as complete/partway without a real sleep — same technique as spec/factories.test.ts's rewindCycle. */
function rewindResearch(store: ReturnType<typeof openStore>, lobbyId: string, playerId: string, msAgo: number): void {
  const pastIso = new Date(Date.now() - msAgo).toISOString();
  store.db
    .prepare("UPDATE skill_research SET started_at = ? WHERE lobby_id = ? AND player_id = ?")
    .run(pastIso, lobbyId, playerId);
}

// ANU-031: speedMultiplier is exported so server/index.ts can put the exact
// same number on the skillTree broadcast (ServerSkillTree.speedMultiplier)
// instead of the Research tab reimplementing this curve client-side.
it("speedMultiplier is 1x at 0 TFLOPS and 2x at 100 TFLOPS (one mega data center)", () => {
  expect(speedMultiplier(0)).toBe(1);
  expect(speedMultiplier(100)).toBe(2);
});

it("starting research on a root (no-prerequisite) node succeeds immediately with no TFLOPS cost", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  const result = skillTree.startResearch(lobbyId, playerId, "better-fabs");
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.state.researching?.nodeId).toBe("better-fabs");
  expect(result.state.unlockedNodeIds).not.toContain("better-fabs"); // not unlocked yet — research just started
  store.close();
});

it("holding a mega data center (100 TFLOPS) completes a node's research in less elapsed time than holding none, at the same backdated duration", () => {
  const { store, territory, skillTree, lobbyId, playerId } = setup();

  // better-fabs's baseResearchTimeMs is 30_000 (skill-tree-nodes.js). At 0
  // TFLOPS (1x speed), rewinding 20_000ms is NOT yet complete.
  skillTree.startResearch(lobbyId, playerId, "better-fabs");
  rewindResearch(store, lobbyId, playerId, 20_000);
  expect(skillTree.getState(lobbyId, playerId).unlockedNodeIds).not.toContain("better-fabs");

  // Holding the mega DC doubles speed (speedMultiplier = 1 + 100/100 = 2) —
  // required duration halves to 15_000ms, so the same 20_000ms elapsed is
  // now enough to complete it.
  giveDataCenter(store, lobbyId, playerId, MEGA_DATA_CENTER_SAL_CODE);
  expect(skillTree.getState(lobbyId, playerId).unlockedNodeIds).toContain("better-fabs");
  store.close();
});

it("holding no data center still completes a node's research eventually, at base (1x) speed", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  skillTree.startResearch(lobbyId, playerId, "better-fabs");
  rewindResearch(store, lobbyId, playerId, 30_000); // exactly baseResearchTimeMs at 1x
  const state = skillTree.getState(lobbyId, playerId);
  expect(state.unlockedNodeIds).toContain("better-fabs");
  expect(state.researching).toBeNull();
  store.close();
});

it("completing research sets the matching perk-hook multiplier, read back via the same hook server/factories.ts reads from", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  skillTree.startResearch(lobbyId, playerId, "better-fabs");
  rewindResearch(store, lobbyId, playerId, 30_000);
  skillTree.getState(lobbyId, playerId); // triggers settle

  expect(store.perks.getPerkMultipliers(lobbyId, playerId).factoryBuildSpeedMultiplier).toBe(1.5);
  store.close();
});

it("every named perk category sets its documented multiplier once research completes", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  for (const nodeId of ["lean-production", "salvage-training", "rapid-capture", "data-uplink"]) {
    expect(skillTree.startResearch(lobbyId, playerId, nodeId).ok).toBe(true);
    rewindResearch(store, lobbyId, playerId, 30_000);
    skillTree.getState(lobbyId, playerId); // settle this node before starting the next
  }

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

it("rejects starting research on a node whose prerequisite isn't met", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  const result = skillTree.startResearch(lobbyId, playerId, "advanced-drone");
  expect(result).toEqual({ ok: false, reason: "prerequisite-not-met" });
  store.close();
});

it("researching the prerequisite to completion, then starting the dependent node, succeeds", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  expect(skillTree.startResearch(lobbyId, playerId, "drone-chassis").ok).toBe(true);
  rewindResearch(store, lobbyId, playerId, 30_000);
  const result = skillTree.startResearch(lobbyId, playerId, "advanced-drone");
  expect(result.ok).toBe(true);
  store.close();
});

it("rejects starting research on an already-unlocked node", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  skillTree.startResearch(lobbyId, playerId, "better-fabs");
  rewindResearch(store, lobbyId, playerId, 30_000);
  skillTree.getState(lobbyId, playerId); // settle

  const second = skillTree.startResearch(lobbyId, playerId, "better-fabs");
  expect(second).toEqual({ ok: false, reason: "already-unlocked" });

  // Multiplier stays at its single-completion value, not doubled/stacked —
  // setPerkMultiplier is absolute (server/perks.ts).
  expect(store.perks.getPerkMultipliers(lobbyId, playerId).factoryBuildSpeedMultiplier).toBe(1.5);
  store.close();
});

it("rejects starting a second research while one is already in progress — one active slot per player, not a queue", () => {
  const { store, skillTree, lobbyId, playerId } = setup();

  expect(skillTree.startResearch(lobbyId, playerId, "better-fabs").ok).toBe(true);
  const second = skillTree.startResearch(lobbyId, playerId, "lean-production");
  expect(second).toEqual({ ok: false, reason: "already-researching" });

  // Even re-requesting the SAME node that's already in progress is rejected,
  // not treated as a silent no-op restart.
  const sameAgain = skillTree.startResearch(lobbyId, playerId, "better-fabs");
  expect(sameAgain).toEqual({ ok: false, reason: "already-researching" });
  store.close();
});

it("rejects an unknown node id", () => {
  const { store, skillTree, lobbyId, playerId } = setup();
  const result = skillTree.startResearch(lobbyId, playerId, "not-a-real-node");
  expect(result).toEqual({ ok: false, reason: "unknown-node" });
  store.close();
});

it("lean-production's factoryBuildCostMultiplier actually halves a new factory's scrap cost through factories.buildFactory, not just a row in the perk table (ANU-022: this node was repointed from unit cost to factory cost once units stopped costing scrap)", () => {
  const { store, territory, skillTree, lobbyId, playerId } = setup();
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  store.startLobby(lobbyId);
  territory.assignSpawnOwnership(lobbyId, [playerId]);
  factories.spawnFactories(lobbyId, [playerId]);
  const existingSalCode = factories.getFactories(lobbyId)[0].sal_code;

  expect(skillTree.startResearch(lobbyId, playerId, "lean-production").ok).toBe(true);
  rewindResearch(store, lobbyId, playerId, 30_000);
  skillTree.getState(lobbyId, playerId); // settle

  const secondSalCode = mapData.suburbs.find((s) => s.sal_code !== existingSalCode)!.sal_code;
  store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  ).run(lobbyId, secondSalCode, playerId);

  store.db.prepare("UPDATE lobby_members SET scrap = scrap + ? WHERE lobby_id = ? AND player_id = ?").run(FACTORY_BUILD_COST_SCRAP, lobbyId, playerId);
  const result = factories.buildFactory(lobbyId, playerId, secondSalCode);
  expect(result.ok).toBe(true);

  // FACTORY_BUILD_COST_SCRAP (20) at 0.5x should deduct exactly 10, not round back up.
  const economy = store.getMemberEconomy(lobbyId, playerId)!;
  expect(economy.scrap).toBe(FACTORY_BUILD_COST_SCRAP - 10);
  store.close();
});

it("the advanced-drone node's own unit_types row (seedSkillGatedUnitTypes) only starts auto-producing at a factory once unlocked", () => {
  const { store, territory, skillTree, lobbyId, playerId } = setup();
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  store.startLobby(lobbyId);
  territory.assignSpawnOwnership(lobbyId, [playerId]);
  factories.spawnFactories(lobbyId, [playerId]);

  const beforeUnlock = factories.getFactories(lobbyId)[0];
  expect(beforeUnlock.production.map((p) => p.unitTypeKey)).not.toContain("drone-mk2");

  expect(skillTree.startResearch(lobbyId, playerId, "drone-chassis").ok).toBe(true);
  rewindResearch(store, lobbyId, playerId, 30_000);
  skillTree.getState(lobbyId, playerId); // settle drone-chassis before starting advanced-drone
  expect(skillTree.startResearch(lobbyId, playerId, "advanced-drone").ok).toBe(true);
  rewindResearch(store, lobbyId, playerId, 45_000);
  skillTree.getState(lobbyId, playerId); // settle advanced-drone

  const afterUnlock = factories.getFactories(lobbyId)[0];
  expect(afterUnlock.production.map((p) => p.unitTypeKey)).toContain("drone-mk2");
  store.close();
});

it("the gated advanced variant's base type (drone) still auto-produces without the node, per issues/ANU-016.md's Done-when", () => {
  const { store, territory, lobbyId, playerId } = setup();
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  store.startLobby(lobbyId);
  territory.assignSpawnOwnership(lobbyId, [playerId]);
  factories.spawnFactories(lobbyId, [playerId]);

  const factory = factories.getFactories(lobbyId)[0];
  expect(factory.production.map((p) => p.unitTypeKey)).toContain("drone");
  store.close();
});

it("nodes are scoped per (lobby, player) — one member's research doesn't affect another's", () => {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const tflopsSource = createTflopsSource(territory);
  const skillTree = createSkillTree(store.db, tflopsSource);
  const { playerId: a } = store.resolvePlayer(undefined);
  const { playerId: b } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("skill-tree-scope", 4, a, "player-a");
  store.joinLobby(b, lobby.lobbyId, "player-b");

  skillTree.startResearch(lobby.lobbyId, a, "better-fabs");
  const pastIso = new Date(Date.now() - 30_000).toISOString();
  store.db.prepare("UPDATE skill_research SET started_at = ? WHERE lobby_id = ? AND player_id = ?").run(pastIso, lobby.lobbyId, a);

  expect(skillTree.getState(lobby.lobbyId, a).unlockedNodeIds).toContain("better-fabs");
  expect(skillTree.getState(lobby.lobbyId, b).unlockedNodeIds).not.toContain("better-fabs");
  expect(store.perks.getPerkMultipliers(lobby.lobbyId, b)).toEqual(DEFAULT_PERK_MULTIPLIERS);
  store.close();
});
