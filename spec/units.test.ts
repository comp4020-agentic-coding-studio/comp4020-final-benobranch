// Checks ANU-014's real drone/robot rules on top of ANU-013's occupancy
// primitive: distinct stats, movement-mode reachability (drones ignore
// adjacency/corridor, robots don't), and the random-element combat
// resolution (confirmed with the user via AskUserQuestion — see
// issues/ANU-014.md Resolution). Exercised by directly importing
// server/units.ts against a real in-memory SQLite connection (same
// pattern as spec/perks.test.ts) rather than over the WebSocket protocol,
// since neither an injectable RNG nor a lobby member's scrap balance has a
// message shape to read it back through.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { createTerritory } from "../server/territory.ts";
import { createUnits } from "../server/units.ts";

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

// The 4-player spawn ring's first entry, and one of its real road-adjacent
// neighbours, and a suburb nowhere near either — all read from the same
// baked map.json the server loads, not hardcoded guesses.
const SPAWN_SAL_CODE = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
const ADJACENT_SAL_CODE = [...adjacency.get(SPAWN_SAL_CODE)!][0];
const NON_ADJACENT_SAL_CODE = mapData.suburbs.find(
  (s) => s.sal_code !== SPAWN_SAL_CODE && !adjacency.get(SPAWN_SAL_CODE)!.has(s.sal_code),
)!.sal_code;

function setup() {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const { playerId: owner } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("units-test", 4, owner, "attacker");
  store.startLobby(lobby.lobbyId);
  // Gives `owner` SPAWN_SAL_CODE per the real 4-player spawn table, so
  // ADJACENT_SAL_CODE is a genuine road-adjacency check, not a fixture
  // coincidence.
  territory.assignSpawnOwnership(lobby.lobbyId, [owner]);
  return { store, lobbyId: lobby.lobbyId, owner };
}

it("seeds drone and robot as genuinely distinct: robot has strictly higher health and damage, drone's movement_mode is fly", () => {
  const { store } = setup();
  const drone = store.db.prepare("SELECT health, damage, movement_mode FROM unit_types WHERE key = ?").get("drone") as {
    health: number;
    damage: number;
    movement_mode: string;
  };
  const robot = store.db.prepare("SELECT health, damage, movement_mode FROM unit_types WHERE key = ?").get("robot") as {
    health: number;
    damage: number;
    movement_mode: string;
  };
  expect(drone.movement_mode).toBe("fly");
  expect(robot.movement_mode).toBe("ground");
  expect(robot.health).toBeGreaterThan(drone.health);
  expect(robot.damage).toBeGreaterThan(drone.damage);
  store.close();
});

it("a drone can move to a suburb with no road adjacency to anything it owns", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  const placed = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  expect(placed.ok).toBe(true);
  if (!placed.ok) throw new Error("unreachable");

  const moved = units.moveUnit(lobbyId, owner, placed.unit.id, NON_ADJACENT_SAL_CODE);
  expect(moved.ok).toBe(true);
  store.close();
});

it("a robot cannot move to a suburb with no road adjacency to anything it owns", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  const placed = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");
  expect(placed.ok).toBe(true);
  if (!placed.ok) throw new Error("unreachable");

  const moved = units.moveUnit(lobbyId, owner, placed.unit.id, NON_ADJACENT_SAL_CODE);
  expect(moved).toEqual({ ok: false, reason: "unreachable" });
  store.close();
});

it("a robot CAN move to a suburb road-adjacent to one it owns", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  const placed = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");
  expect(placed.ok).toBe(true);
  if (!placed.ok) throw new Error("unreachable");

  const moved = units.moveUnit(lobbyId, owner, placed.unit.id, ADJACENT_SAL_CODE);
  expect(moved.ok).toBe(true);
  if (moved.ok) expect(moved.unit.sal_code).toBe(ADJACENT_SAL_CODE);
  store.close();
});

it("attacking an undefended suburb (no enemy units present) just moves the attacker there", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  const placed = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  if (!placed.ok) throw new Error("unreachable");

  const result = units.attackSuburb(lobbyId, owner, placed.unit.id, NON_ADJACENT_SAL_CODE);
  expect(result).toEqual({
    ok: true,
    outcome: "moved",
    unit: { ...placed.unit, sal_code: NON_ADJACENT_SAL_CODE },
  });
  store.close();
});

it("combat resolution is deterministic for a given rng sequence (same inputs, same outcome)", () => {
  const { store, lobbyId, owner } = setup();
  const { playerId: defenderOwner } = store.resolvePlayer(undefined);
  // Fixed roll sequence: the injected rng always returns 1, pinning damage
  // variance at its maximum (+20%) for a reproducible assertion. Attacker
  // is a drone (weaker) against a robot defender (tougher) specifically so
  // even the max-variance hit doesn't kill in one shot — isolates the "hit"
  // branch from the "kill" branch covered separately below.
  const units = createUnits(store.db, () => 1);

  const attacker = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  const defender = units.placeUnit(lobbyId, defenderOwner, NON_ADJACENT_SAL_CODE, "robot");
  if (!attacker.ok || !defender.ok) throw new Error("unreachable");

  // Drone base damage is seeded at 2 (seedBaseUnitTypes) — at the max +20%
  // roll that's round(2 * 1.2) = 2 damage dealt, same every time this rng
  // is used.
  const result = units.attackSuburb(lobbyId, owner, attacker.unit.id, NON_ADJACENT_SAL_CODE);
  expect(result.ok).toBe(true);
  if (result.ok && result.outcome === "hit") {
    expect(result.damageDealt).toBe(2);
    expect(result.defender.health).toBe(defender.unit.health - 2);
  } else {
    throw new Error(`expected a 'hit' outcome, got ${JSON.stringify(result)}`);
  }
  store.close();
});

it("the rng actually varies outcomes — not secretly deterministic regardless of the injected rng", () => {
  const { store, lobbyId, owner } = setup();
  const { playerId: defenderOwner } = store.resolvePlayer(undefined);

  // Robot vs. robot, attacking the owner's road-adjacent suburb (6 health,
  // 4 damage): even the max +20% roll (5 damage) leaves the defender
  // alive, so every roll below lands in the "hit" branch and damageDealt
  // is comparable across all five.
  const damages = new Set<number>();
  for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
    const units = createUnits(store.db, () => roll);
    const attacker = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");
    const defender = units.placeUnit(lobbyId, defenderOwner, ADJACENT_SAL_CODE, "robot");
    if (!attacker.ok || !defender.ok) throw new Error("unreachable");
    const result = units.attackSuburb(lobbyId, owner, attacker.unit.id, ADJACENT_SAL_CODE);
    if (!result.ok || result.outcome !== "hit") throw new Error(`expected a 'hit' outcome, got ${JSON.stringify(result)}`);
    damages.add(result.damageDealt);
    // Clean up both units so the next roll starts from a fresh single defender.
    store.db.prepare("DELETE FROM units WHERE id IN (?, ?)").run(attacker.unit.id, defender.unit.id);
  }
  expect(damages.size, "varying the injected rng should produce more than one distinct damage value").toBeGreaterThan(1);
  store.close();
});

it("a kill destroys the defender, credits scrap scaled by scrapPerKillMultiplier, and the attacker advances", () => {
  const { store, lobbyId, owner } = setup();
  const { playerId: defenderOwner } = store.resolvePlayer(undefined);
  store.perks.setPerkMultiplier(lobbyId, owner, "scrapPerKillMultiplier", 2);
  // rng() = 1 and a drone's 1-health-short setup below guarantees a kill on the first hit.
  const units = createUnits(store.db, () => 1);

  const attacker = units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");
  const defender = units.placeUnit(lobbyId, defenderOwner, ADJACENT_SAL_CODE, "drone");
  if (!attacker.ok || !defender.ok) throw new Error("unreachable");
  // Drone base health is 3 (seedBaseUnitTypes); robot's max-roll hit deals
  // 5, which exceeds it — guaranteed kill in one hit.
  const result = units.attackSuburb(lobbyId, owner, attacker.unit.id, ADJACENT_SAL_CODE);
  expect(result.ok).toBe(true);
  if (!result.ok || result.outcome !== "kill") throw new Error(`expected a 'kill' outcome, got ${JSON.stringify(result)}`);

  // Drone scrap_value is seeded at 2 (seedBaseUnitTypes); x2 multiplier = 4.
  expect(result.scrapCredited).toBe(4);
  expect(result.attacker.sal_code).toBe(ADJACENT_SAL_CODE);

  const economy = store.getMemberEconomy(lobbyId, owner)!;
  expect(economy.scrap).toBe(4);

  const remaining = units.getOccupancy(lobbyId).filter((u) => u.sal_code === ADJACENT_SAL_CODE);
  expect(remaining.find((u) => u.id === defender.unit.id), "the destroyed defender should no longer occupy the suburb").toBeUndefined();
  store.close();
});

it("placeUnit stays unrestricted by adjacency (ANU-017's capture-contest tests rely on placing anywhere)", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  const placed = units.placeUnit(lobbyId, owner, NON_ADJACENT_SAL_CODE, "robot");
  expect(placed.ok).toBe(true);
  store.close();
});
