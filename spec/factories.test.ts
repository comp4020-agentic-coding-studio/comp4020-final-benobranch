// Checks ANU-015's factory primitive as reworked by ANU-022: one factory
// per player at spawn on kickoff, every factory auto-produces every
// buildable unit type concurrently on its own timer with no scrap cost and
// no player choice, each completed cycle places a real unit via ANU-013's
// occupancy primitive and immediately restarts, factoryBuildSpeedMultiplier
// scales cycle duration, a skill-node-gated type only starts auto-producing
// once unlocked, and scrap is spent ONLY on buildFactory (including through
// the repurposed factoryBuildCostMultiplier perk hook, and the
// near-simultaneous double-build race that hook's synchronous deduction must
// still resolve to exactly one winner). Exercised by directly importing
// server/factories.ts against a real in-memory SQLite connection (same
// pattern as spec/units.test.ts / spec/perks.test.ts) rather than over the
// WebSocket protocol, since there's no message to read a lobby member's
// scrap balance back through.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { createTerritory } from "../server/territory.ts";
import { createUnits } from "../server/units.ts";
import { createFactories, FACTORY_BUILD_COST_SCRAP } from "../server/factories.ts";

const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as { suburbs: { sal_code: string }[] };

function setupSingle() {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  const { playerId: owner } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("factories-test", 4, owner, "owner");
  store.startLobby(lobby.lobbyId);
  territory.assignSpawnOwnership(lobby.lobbyId, [owner]);
  factories.spawnFactories(lobby.lobbyId, [owner]);
  return { store, units, factories, lobbyId: lobby.lobbyId, owner };
}

function giveScrap(store: ReturnType<typeof openStore>, lobbyId: string, playerId: string, amount: number): void {
  store.db.prepare("UPDATE lobby_members SET scrap = scrap + ? WHERE lobby_id = ? AND player_id = ?").run(amount, lobbyId, playerId);
}

/** Pushes a factory's stored cycle_started_at for one unit type into the past, so its production cycle reads as complete/partway without a real sleep. */
function rewindCycle(store: ReturnType<typeof openStore>, factoryId: string, unitTypeKey: string, msAgo: number): void {
  const pastIso = new Date(Date.now() - msAgo).toISOString();
  store.db
    .prepare("UPDATE factory_production SET cycle_started_at = ? WHERE factory_id = ? AND unit_type_key = ?")
    .run(pastIso, factoryId, unitTypeKey);
}

it("each player has exactly one factory at their spawn suburb immediately after startLobby", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  const spawned = factories.getFactories(lobbyId);
  expect(spawned).toHaveLength(1);
  expect(spawned[0].ownerPlayerId).toBe(owner);
  const ownedSalCodes = Object.values(store.db.prepare("SELECT sal_code FROM suburb_ownership WHERE lobby_id = ? AND owner_player_id = ?").all(lobbyId, owner) as { sal_code: string }[]).map((r) => r.sal_code);
  expect(ownedSalCodes).toContain(spawned[0].sal_code);
  store.close();
});

it("every lobby member gets exactly one factory, not just the first", () => {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  const { playerId: a } = store.resolvePlayer(undefined);
  const { playerId: b } = store.resolvePlayer(undefined);
  const { playerId: c } = store.resolvePlayer(undefined);
  const { playerId: d } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("factories-multi", 4, a, "a");
  store.joinLobby(b, lobby.lobbyId, "b");
  store.joinLobby(c, lobby.lobbyId, "c");
  store.joinLobby(d, lobby.lobbyId, "d");
  store.startLobby(lobby.lobbyId);
  const members = [a, b, c, d];
  territory.assignSpawnOwnership(lobby.lobbyId, members);
  factories.spawnFactories(lobby.lobbyId, members);

  const spawned = factories.getFactories(lobby.lobbyId);
  expect(spawned).toHaveLength(4);
  expect(new Set(spawned.map((f) => f.ownerPlayerId))).toEqual(new Set(members));
  store.close();
});

it("a fresh factory auto-produces every base unit type concurrently, each starting at 0 progress, with no scrap spent", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  const factory = factories.getFactories(lobbyId)[0];

  const keys = factory.production.map((p) => p.unitTypeKey).sort();
  expect(keys).toEqual(["drone", "robot"]);
  // A few microseconds elapse between the cycle starting and this read, so
  // "just started" is a tiny positive fraction, not exactly 0.
  for (const cycle of factory.production) expect(cycle.progressFraction).toBeLessThan(0.01);

  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap, "nothing should ever deduct scrap for unit production").toBe(0);
  store.close();
});

it("a completed production cycle places a real unit via ANU-013's occupancy primitive and restarts that type's cycle, without disturbing the other type's progress", () => {
  const { store, factories, units, lobbyId, owner } = setupSingle();
  const factory = factories.getFactories(lobbyId)[0];

  // drone build_time_ms is seeded at 1500 (server/units.ts) — force it complete.
  rewindCycle(store, factory.id, "drone", 5000);

  const settled = factories.getFactories(lobbyId)[0];
  const droneCycle = settled.production.find((p) => p.unitTypeKey === "drone")!;
  expect(droneCycle.progressFraction, "the cycle restarts immediately on completion, not left at 1").toBeLessThan(0.1);
  const robotCycle = settled.production.find((p) => p.unitTypeKey === "robot")!;
  expect(robotCycle.progressFraction, "the robot cycle is independent — completing drone's shouldn't touch it").toBeLessThan(0.01);

  const occupancy = units.getOccupancy(lobbyId);
  expect(occupancy).toHaveLength(1);
  expect(occupancy[0].ownerPlayerId).toBe(owner);
  expect(occupancy[0].sal_code).toBe(factory.sal_code);
  expect(occupancy[0].unitTypeKey).toBe("drone");
  store.close();
});

it("a production cycle's progress fraction is scaled by factoryBuildSpeedMultiplier", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  store.perks.setPerkMultiplier(lobbyId, owner, "factoryBuildSpeedMultiplier", 2); // twice as fast
  const factory = factories.getFactories(lobbyId)[0]; // creates cycle rows, both started "now"

  // Half of (robot's 3000ms / 2 = 1500ms effective duration) elapsed = 750ms ago.
  rewindCycle(store, factory.id, "robot", 750);

  const state = factories.getFactories(lobbyId).find((f) => f.id === factory.id)!;
  const robotCycle = state.production.find((p) => p.unitTypeKey === "robot")!;
  expect(robotCycle.progressFraction).toBeGreaterThan(0.4);
  expect(robotCycle.progressFraction).toBeLessThan(0.6);
  store.close();
});

it("buildFactory allows an additional factory in any suburb the player owns (confirmed: no adjacency restriction)", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, FACTORY_BUILD_COST_SCRAP);

  // Give the player ownership of a second, arbitrary suburb (not adjacent to
  // anything in particular) to prove placement isn't adjacency-restricted.
  const secondSalCode = mapData.suburbs[50].sal_code;
  store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  ).run(lobbyId, secondSalCode, owner);

  const result = factories.buildFactory(lobbyId, owner, secondSalCode);
  expect(result.ok).toBe(true);

  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap).toBe(0);

  expect(factories.getFactories(lobbyId)).toHaveLength(2);
  store.close();
});

it("buildFactory with a non-1 build-cost multiplier deducts the scaled cost, proving the perk hook is actually read (ANU-022: this is scrap's only remaining spend)", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, FACTORY_BUILD_COST_SCRAP);
  store.perks.setPerkMultiplier(lobbyId, owner, "factoryBuildCostMultiplier", 0.5);

  const secondSalCode = mapData.suburbs[50].sal_code;
  store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  ).run(lobbyId, secondSalCode, owner);

  const result = factories.buildFactory(lobbyId, owner, secondSalCode);
  expect(result.ok).toBe(true);

  // FACTORY_BUILD_COST_SCRAP (20) at 0.5x is an exact integer (10), not a rounding artifact.
  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap).toBe(FACTORY_BUILD_COST_SCRAP - 10);
  store.close();
});

it("buildFactory rejects a suburb the player doesn't own", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, FACTORY_BUILD_COST_SCRAP);
  const existingSalCode = factories.getFactories(lobbyId)[0].sal_code;
  const unownedSalCode = mapData.suburbs.find((s) => s.sal_code !== existingSalCode)!.sal_code;

  const result = factories.buildFactory(lobbyId, owner, unownedSalCode);
  expect(result).toEqual({ ok: false, reason: "not-owner" });
  store.close();
});

it("buildFactory rejects a suburb that already has a factory", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, FACTORY_BUILD_COST_SCRAP);
  const existingFactory = factories.getFactories(lobbyId)[0];

  const result = factories.buildFactory(lobbyId, owner, existingFactory.sal_code);
  expect(result).toEqual({ ok: false, reason: "already-exists" });
  store.close();
});

it("buildFactory rejects an insufficient scrap balance", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  const secondSalCode = mapData.suburbs[50].sal_code;
  store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  ).run(lobbyId, secondSalCode, owner);

  const result = factories.buildFactory(lobbyId, owner, secondSalCode);
  expect(result).toEqual({ ok: false, reason: "insufficient-scrap" });
  store.close();
});

it("two near-simultaneous buildFactory requests against a single-build-affordable balance: exactly one succeeds", () => {
  // Isolates the double-spend race the scrap deduction must guard against,
  // same reasoning as ADR 0001's synchronous-handler guarantee — ANU-022
  // moved this race from queueUnit (removed) to buildFactory, the only
  // remaining scrap-spending action.
  const { store, factories, lobbyId, owner } = setupSingle();
  const secondSalCode = mapData.suburbs[50].sal_code;
  const thirdSalCode = mapData.suburbs[51].sal_code;
  store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  ).run(lobbyId, secondSalCode, owner);
  store.db.prepare(
    "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
  ).run(lobbyId, thirdSalCode, owner);

  // Exactly enough scrap for ONE factory, not two.
  giveScrap(store, lobbyId, owner, FACTORY_BUILD_COST_SCRAP);

  const resultA = factories.buildFactory(lobbyId, owner, secondSalCode);
  const resultB = factories.buildFactory(lobbyId, owner, thirdSalCode);

  const outcomes = [resultA.ok, resultB.ok];
  expect(outcomes.filter((ok) => ok), "exactly one of the two near-simultaneous requests should succeed").toHaveLength(1);

  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap, "scrap must not go negative or be double-spent").toBe(0);
  store.close();
});

it("transferFactoryOwnership (confirmed: capture TRANSFERS the factory, doesn't destroy it) changes the owner, and in-progress production continues for the new owner", () => {
  const { store, factories, units, lobbyId, owner } = setupSingle();
  const { playerId: capturer } = store.resolvePlayer(undefined);
  const factory = factories.getFactories(lobbyId)[0]; // creates cycle rows

  factories.transferFactoryOwnership(lobbyId, factory.sal_code, capturer);

  const afterTransfer = factories.getFactories(lobbyId).find((f) => f.sal_code === factory.sal_code)!;
  expect(afterTransfer.ownerPlayerId, "ownership must move to the capturer").toBe(capturer);
  expect(afterTransfer.production.map((p) => p.unitTypeKey).sort(), "production continues, not reset, across a transfer").toEqual(["drone", "robot"]);

  // Force completion — the resulting unit must belong to the NEW owner, not
  // whoever owned the factory when the cycle started.
  rewindCycle(store, factory.id, "drone", 5000);
  factories.getFactories(lobbyId); // triggers settle()

  const placedUnits = units.getOccupancy(lobbyId);
  expect(placedUnits).toHaveLength(1);
  expect(placedUnits[0].ownerPlayerId, "the completed build belongs to the capturing player, not whoever owned the factory when the cycle started").toBe(capturer);
  store.close();
});

it("a skill-node-gated unit type doesn't auto-produce at a factory until the owner has unlocked it", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  store.db.exec(`
    INSERT INTO unit_types (key, health, damage, scrap_value, build_time_ms, movement_mode, requires_skill_node)
    VALUES ('advanced-drone', 5, 3, 3, 1500, 'fly', 'drone-tech')
  `);

  const beforeUnlock = factories.getFactories(lobbyId)[0];
  expect(beforeUnlock.production.map((p) => p.unitTypeKey)).not.toContain("advanced-drone");

  store.db.prepare("INSERT INTO skill_nodes (lobby_id, player_id, node_id, unlocked_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(lobbyId, owner, "drone-tech");

  const afterUnlock = factories.getFactories(lobbyId)[0];
  const gatedCycle = afterUnlock.production.find((p) => p.unitTypeKey === "advanced-drone");
  expect(gatedCycle, "the gated type should start auto-producing the moment its node is unlocked, with no factories.ts code change needed").toBeDefined();
  expect(gatedCycle!.progressFraction).toBeLessThan(0.01);
  store.close();
});
