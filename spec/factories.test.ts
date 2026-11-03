// Checks ANU-015's factory production queue: one factory per player at
// spawn on kickoff, queueing a unit deducts scrap (including through the
// factoryBuildCostMultiplier perk hook, to prove the hook is actually read),
// a near-simultaneous double-queue against an insufficient-for-both scrap
// balance resolves to exactly one succeeding, a completed queue item places
// a real unit via ANU-013's occupancy primitive, building an additional
// factory and transferring one on capture. Exercised by directly importing
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

it("queueing a unit deducts the correct scrap", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, 10);
  const factoryId = factories.getFactories(lobbyId)[0].id;

  // drone build_cost_scrap is seeded at 2 (server/units.ts's seedBaseUnitTypes).
  const result = factories.queueUnit(lobbyId, owner, factoryId, "drone");
  expect(result.ok).toBe(true);

  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap).toBe(8);
  store.close();
});

it("queueing a unit with a non-1 build-cost multiplier deducts the scaled cost, proving the perk hook is actually read", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, 10);
  store.perks.setPerkMultiplier(lobbyId, owner, "factoryBuildCostMultiplier", 0.5);
  const factoryId = factories.getFactories(lobbyId)[0].id;

  // robot build_cost_scrap is seeded at 4; at 0.5x that's an exact integer (2), not a rounding artifact.
  const result = factories.queueUnit(lobbyId, owner, factoryId, "robot");
  expect(result.ok).toBe(true);

  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap).toBe(8);
  store.close();
});

it("rejects queueing with insufficient scrap", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  // No scrap given — drone costs 2.
  const factoryId = factories.getFactories(lobbyId)[0].id;
  const result = factories.queueUnit(lobbyId, owner, factoryId, "drone");
  expect(result).toEqual({ ok: false, reason: "insufficient-scrap" });
  store.close();
});

it("rejects queueing a second unit at a factory already mid-build ('busy')", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, 10);
  const factoryId = factories.getFactories(lobbyId)[0].id;

  expect(factories.queueUnit(lobbyId, owner, factoryId, "drone").ok).toBe(true);
  const second = factories.queueUnit(lobbyId, owner, factoryId, "drone");
  expect(second).toEqual({ ok: false, reason: "busy" });
  store.close();
});

it("two near-simultaneous queue requests against a single-unit-affordable balance: exactly one succeeds, via two owned factories", () => {
  // Two idle factories so neither request is rejected for "busy" instead of
  // scrap — isolates the double-spend race the scrap deduction must guard
  // against, same reasoning as ADR 0001's synchronous-handler guarantee.
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const factories = createFactories(store.db, units);
  const { playerId: owner } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("factories-race2", 4, owner, "owner");
  store.startLobby(lobby.lobbyId);
  territory.assignSpawnOwnership(lobby.lobbyId, [owner]);
  factories.spawnFactories(lobby.lobbyId, [owner]);

  const ownedSalCodes = (store.db.prepare("SELECT sal_code FROM suburb_ownership WHERE lobby_id = ? AND owner_player_id = ?").all(lobby.lobbyId, owner) as { sal_code: string }[]).map((r) => r.sal_code);
  const spawnSalCode = ownedSalCodes[0];
  // A second factory in the SAME owned suburb would collide with the
  // already-spawned one (not "already-exists" safe) — build it directly
  // against the store instead of through buildFactory's single-suburb
  // uniqueness check, since this test is isolating the scrap race, not
  // buildFactory's placement rule (covered separately below).
  const secondFactoryId = "second-factory";
  store.db.prepare("INSERT INTO factories (id, lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?, ?)").run(secondFactoryId, lobby.lobbyId, spawnSalCode, owner);

  // Exactly enough scrap for ONE drone (cost 2), not two.
  giveScrap(store, lobby.lobbyId, owner, 2);

  const firstFactoryId = factories.getFactories(lobby.lobbyId).find((f) => f.id !== secondFactoryId)!.id;
  const resultA = factories.queueUnit(lobby.lobbyId, owner, firstFactoryId, "drone");
  const resultB = factories.queueUnit(lobby.lobbyId, owner, secondFactoryId, "drone");

  const outcomes = [resultA.ok, resultB.ok];
  expect(outcomes.filter((ok) => ok), "exactly one of the two near-simultaneous requests should succeed").toHaveLength(1);

  const economy = store.getMemberEconomy(lobby.lobbyId, owner)!;
  expect(economy.scrap, "scrap must not go negative or be double-spent").toBe(0);
  store.close();
});

it("a completed queue item places a real unit via ANU-013's occupancy primitive and clears the queue", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, 10);
  const factory = factories.getFactories(lobbyId)[0];

  const queued = factories.queueUnit(lobbyId, owner, factory.id, "drone");
  expect(queued.ok).toBe(true);

  // Force the stored queue_started_at into the past so elapsedMs reports
  // the build as complete without needing a real sleep (drone build_time_ms
  // is seeded at 1500 — see server/units.ts).
  const pastIso = new Date(Date.now() - 5000).toISOString();
  store.db.prepare("UPDATE factories SET queue_started_at = ? WHERE id = ?").run(pastIso, factory.id);

  const settled = factories.getFactories(lobbyId);
  expect(settled[0].queuedUnitTypeKey, "the queue should clear once the build completes").toBeNull();

  const occupancy = store.db.prepare("SELECT owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey FROM units WHERE lobby_id = ?").all(lobbyId) as { ownerPlayerId: string; salCode: string; unitTypeKey: string }[];
  expect(occupancy).toHaveLength(1);
  expect(occupancy[0].ownerPlayerId).toBe(owner);
  expect(occupancy[0].salCode).toBe(factory.sal_code);
  expect(occupancy[0].unitTypeKey).toBe("drone");
  store.close();
});

it("a queued build's progress fraction is scaled by factoryBuildSpeedMultiplier", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, 10);
  store.perks.setPerkMultiplier(lobbyId, owner, "factoryBuildSpeedMultiplier", 2); // twice as fast
  const factory = factories.getFactories(lobbyId)[0];
  factories.queueUnit(lobbyId, owner, factory.id, "robot"); // build_time_ms 3000

  // Half of (3000 / 2 = 1500ms effective duration) elapsed = 750ms ago.
  const halfwayIso = new Date(Date.now() - 750).toISOString();
  store.db.prepare("UPDATE factories SET queue_started_at = ? WHERE id = ?").run(halfwayIso, factory.id);

  const state = factories.getFactories(lobbyId).find((f) => f.id === factory.id)!;
  expect(state.queuedUnitTypeKey).toBe("robot"); // not yet complete
  expect(state.queueProgressFraction).not.toBeNull();
  expect(state.queueProgressFraction!).toBeGreaterThan(0.4);
  expect(state.queueProgressFraction!).toBeLessThan(0.6);
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

it("transferFactoryOwnership (confirmed: capture TRANSFERS the factory, doesn't destroy it) changes the owner, preserving any in-progress build", () => {
  const { store, factories, units, lobbyId, owner } = setupSingle();
  const { playerId: capturer } = store.resolvePlayer(undefined);
  giveScrap(store, lobbyId, owner, 10);
  const factory = factories.getFactories(lobbyId)[0];
  factories.queueUnit(lobbyId, owner, factory.id, "drone");

  factories.transferFactoryOwnership(lobbyId, factory.sal_code, capturer);

  const afterTransfer = factories.getFactories(lobbyId).find((f) => f.sal_code === factory.sal_code)!;
  expect(afterTransfer.ownerPlayerId, "ownership must move to the capturer").toBe(capturer);
  expect(afterTransfer.queuedUnitTypeKey, "an in-progress build must survive the transfer, not be cancelled").toBe("drone");

  // Force completion — the resulting unit must belong to the NEW owner, not
  // whoever originally queued it, per the confirmed capture rule.
  const pastIso = new Date(Date.now() - 5000).toISOString();
  store.db.prepare("UPDATE factories SET queue_started_at = ? WHERE id = ?").run(pastIso, factory.id);
  factories.getFactories(lobbyId); // triggers settle()

  const placedUnits = units.getOccupancy(lobbyId);
  expect(placedUnits).toHaveLength(1);
  expect(placedUnits[0].ownerPlayerId, "the completed build belongs to the capturing player, not the original queuer").toBe(capturer);
  store.close();
});

it("rejects queueing a skill-node-gated unit type the player hasn't unlocked", () => {
  const { store, factories, lobbyId, owner } = setupSingle();
  giveScrap(store, lobbyId, owner, 100);
  store.db.exec(`
    INSERT INTO unit_types (key, health, damage, build_cost_scrap, build_time_ms, movement_mode, requires_skill_node)
    VALUES ('advanced-drone', 5, 3, 3, 1500, 'fly', 'drone-tech')
  `);
  const factoryId = factories.getFactories(lobbyId)[0].id;

  const locked = factories.queueUnit(lobbyId, owner, factoryId, "advanced-drone");
  expect(locked).toEqual({ ok: false, reason: "locked" });

  store.db.prepare("INSERT INTO skill_nodes (lobby_id, player_id, node_id, unlocked_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(lobbyId, owner, "drone-tech");
  const unlocked = factories.queueUnit(lobbyId, owner, factoryId, "advanced-drone");
  expect(unlocked.ok).toBe(true);
  store.close();
});
