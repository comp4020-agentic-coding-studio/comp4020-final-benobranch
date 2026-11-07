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

// --- moveUnits (ANU-027, travel time added by ANU-038): Risk-style bulk
// move/attack, one order per call. A valid order only DISPATCHES now — it
// stamps destination_sal_code/move_started_at and returns immediately,
// deciding nothing; settleArrivals resolves each dispatched unit once its
// travel time (real suburb distance / the unit type's speed) has elapsed.
// Every test below backdates move_started_at far enough into the past that
// settleArrivals treats travel as already complete, so these can assert on
// the resolved outcome without a real sleep — same backdating convention
// spec/capture.test.ts's backdateCapture uses for CAPTURE_DURATION_MS. --- //

/** Pushes every dispatched unit's move_started_at far enough into the past that settleArrivals treats its travel as complete, regardless of archetype speed or distance. */
function forceArrival(store: ReturnType<typeof openStore>, unitIds: string[]): void {
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const unitId of unitIds) {
    store.db.prepare("UPDATE units SET move_started_at = ? WHERE id = ?").run(longAgo, unitId);
  }
}

it("moveUnits dispatches (not resolves) a valid order: units are in transit, not yet relocated", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  for (let i = 0; i < 5; i++) units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  for (let i = 0; i < 3; i++) units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");

  const result = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 2, robot: 1 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(result.dispatchedUnitIds).toHaveLength(3);

  // Still at the ORIGIN, not the destination — dispatch alone never moves
  // anything (issues/ANU-038.md's confirmed "resolve on arrival" rule).
  const dispatched = units.getOccupancy(lobbyId).filter((u) => result.dispatchedUnitIds.includes(u.id));
  expect(dispatched.every((u) => u.sal_code === SPAWN_SAL_CODE)).toBe(true);
  expect(dispatched.every((u) => u.destinationSalCode === ADJACENT_SAL_CODE)).toBe(true);

  // The 2 drones/1 robot NOT selected stay fully grounded (no destination).
  const atSource = units.getOccupancy(lobbyId).filter((u) => u.sal_code === SPAWN_SAL_CODE);
  expect(atSource.filter((u) => u.unitTypeKey === "drone" && !u.destinationSalCode)).toHaveLength(3);
  expect(atSource.filter((u) => u.unitTypeKey === "robot" && !u.destinationSalCode)).toHaveLength(2);
  store.close();
});

it("settleArrivals resolves a dispatched order once travel time has elapsed, relocating undefended arrivals", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  for (let i = 0; i < 5; i++) units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  for (let i = 0; i < 3; i++) units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");

  const dispatch = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 2, robot: 1 });
  if (!dispatch.ok) throw new Error("unreachable");
  forceArrival(store, dispatch.dispatchedUnitIds);

  const outcomes = units.settleArrivals(lobbyId);
  expect(outcomes).toHaveLength(3);
  expect(outcomes.every((o) => o.outcome === "moved")).toBe(true);

  const atDestination = units.getOccupancy(lobbyId).filter((u) => u.sal_code === ADJACENT_SAL_CODE);
  expect(atDestination.filter((u) => u.unitTypeKey === "drone")).toHaveLength(2);
  expect(atDestination.filter((u) => u.unitTypeKey === "robot")).toHaveLength(1);
  expect(atDestination.every((u) => u.destinationSalCode === undefined)).toBe(true);

  const atSource = units.getOccupancy(lobbyId).filter((u) => u.sal_code === SPAWN_SAL_CODE);
  expect(atSource.filter((u) => u.unitTypeKey === "drone")).toHaveLength(3);
  expect(atSource.filter((u) => u.unitTypeKey === "robot")).toHaveLength(2);
  store.close();
});

it("settleArrivals leaves a unit's travel untouched before its travel time has elapsed", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");

  const dispatch = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 1 });
  if (!dispatch.ok) throw new Error("unreachable");
  // No forceArrival here — move_started_at is "now," so travel time (a real
  // positive duration for a real distance) can't have elapsed yet.

  const outcomes = units.settleArrivals(lobbyId);
  expect(outcomes).toHaveLength(0);

  const unit = units.getOccupancy(lobbyId).find((u) => u.id === dispatch.dispatchedUnitIds[0])!;
  expect(unit.sal_code).toBe(SPAWN_SAL_CODE);
  expect(unit.destinationSalCode).toBe(ADJACENT_SAL_CODE);
  store.close();
});

it("moveUnits rejects an order requesting more of a type than currently sit at the source, without dispatching anything", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");

  const result = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 2 });
  expect(result).toEqual({ ok: false, reason: "insufficient-units" });

  const inTransit = units.getOccupancy(lobbyId).filter((u) => u.destinationSalCode);
  expect(inTransit).toHaveLength(0);
  store.close();
});

it("moveUnits rejects the WHOLE order when any requested type can't reach the destination, not just that type's units", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");

  const result = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, NON_ADJACENT_SAL_CODE, { drone: 1, robot: 1 });
  expect(result).toEqual({ ok: false, reason: "unreachable" });

  // Not even the drone (which COULD individually reach) should have been
  // dispatched — issues/ANU-027.md: "rejected for the whole order ... rather
  // than silently moving the drones and dropping the robots."
  const inTransit = units.getOccupancy(lobbyId).filter((u) => u.destinationSalCode);
  expect(inTransit).toHaveLength(0);
  store.close();
});

it("moveUnits rejects an order with no positive counts (nothing selected)", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");

  const result = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 0 });
  expect(result).toEqual({ ok: false, reason: "no-units-selected" });
  store.close();
});

it("an already in-transit unit can't be dispatched again until it arrives", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");

  const first = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 1 });
  expect(first.ok).toBe(true);

  // The same (only) drone is still mid-flight — selectOwnedUnitsOfTypeAt
  // excludes units with a destination_sal_code set, so there's nothing left
  // at SPAWN_SAL_CODE to select a second time.
  const second = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, NON_ADJACENT_SAL_CODE, { drone: 1 });
  expect(second).toEqual({ ok: false, reason: "insufficient-units" });
  store.close();
});

it("settleArrivals resolves combat against a defended destination on arrival — a unit that gets killed on the way never reaches it", () => {
  const { store, lobbyId, owner } = setup();
  const { playerId: defenderOwner } = store.resolvePlayer(undefined);
  // rng() = 1 guarantees every hit lands at max damage — a lone 10-health
  // defending robot absorbs one attacking drone's max hit (round(2*1.2)=2)
  // without dying, so the first attacker's outcome is "hit" and the second
  // attacker (dispatched in the same order) still gets its own turn
  // afterward, same per-unit-in-order rule as before ANU-038, just resolved
  // on arrival instead of at dispatch.
  const units = createUnits(store.db, () => 1);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  units.placeUnit(lobbyId, defenderOwner, ADJACENT_SAL_CODE, "robot");

  const dispatch = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { drone: 2 });
  if (!dispatch.ok) throw new Error("unreachable");
  forceArrival(store, dispatch.dispatchedUnitIds);

  const outcomes = units.settleArrivals(lobbyId);
  expect(outcomes).toHaveLength(2);
  expect(outcomes.every((o) => o.outcome === "hit")).toBe(true);

  // Neither attacker advanced into the still-defended suburb (a "hit"
  // outcome leaves the attacker in place, same as single-unit attackSuburb)
  // — and both are released from transit (no longer in-flight forever).
  const atDestination = units.getOccupancy(lobbyId).filter((u) => u.sal_code === ADJACENT_SAL_CODE && u.ownerPlayerId === owner);
  expect(atDestination).toHaveLength(0);
  const stillInTransit = units.getOccupancy(lobbyId).filter((u) => u.ownerPlayerId === owner && u.destinationSalCode);
  expect(stillInTransit).toHaveLength(0);
  store.close();
});

it("two units racing for the same contested suburb from separate moveUnits orders resolve in actual-arrival order, each seeing the other's result", () => {
  const { store, lobbyId, owner } = setup();
  const { playerId: defenderOwner } = store.resolvePlayer(undefined);
  // rng() = 1: a robot's max-roll hit (round(4*1.2)=5) exceeds a drone's 3
  // health, guaranteeing a kill. The defending drone is placed directly at
  // ADJACENT_SAL_CODE — undefended until either attacker arrives.
  const units = createUnits(store.db, () => 1);
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "robot");
  units.placeUnit(lobbyId, defenderOwner, ADJACENT_SAL_CODE, "drone");

  // Two SEPARATE orders (not one bulk order), dispatched one after another —
  // settleArrivals must still resolve them in actual arrival order
  // (move_started_at) across both orders, not per-order.
  const firstDispatch = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { robot: 1 });
  const secondDispatch = units.moveUnits(lobbyId, owner, SPAWN_SAL_CODE, ADJACENT_SAL_CODE, { robot: 1 });
  if (!firstDispatch.ok || !secondDispatch.ok) throw new Error("unreachable");
  forceArrival(store, [...firstDispatch.dispatchedUnitIds, ...secondDispatch.dispatchedUnitIds]);

  const outcomes = units.settleArrivals(lobbyId);
  expect(outcomes).toHaveLength(2);
  // The first robot kills the undefended drone and advances; the second
  // robot then arrives at an ALREADY-undefended suburb (the first robot is
  // the same owner, not a defender) and simply moves in too — neither
  // resolves against a stale "the drone is still there" snapshot taken at
  // either one's own dispatch time.
  expect(outcomes[0].outcome).toBe("kill");
  expect(outcomes[1].outcome).toBe("moved");

  const atDestination = units.getOccupancy(lobbyId).filter((u) => u.sal_code === ADJACENT_SAL_CODE);
  expect(atDestination.filter((u) => u.ownerPlayerId === owner)).toHaveLength(2);
  expect(atDestination.find((u) => u.ownerPlayerId === defenderOwner)).toBeUndefined();
  store.close();
});

// ANU-044: "two enemy teams garrisoned in the same zone never fight each
// other — capture just alternates between them instead." Root cause: combat
// only ever resolved at the INSTANT a unit's travel time elapsed
// (settleArrivals above) or via the dead single-unit attackSuburb primitive
// — once two enemy garrisons were both already resolved/stationary in the
// same suburb (sal_code equal, destination_sal_code null, nobody
// "arriving"), nothing ever pitted them against each other again. Meanwhile
// territory.ts's settleSuburb (ANU-017) correctly freezes CAPTURE PROGRESS
// while 2+ distinct non-owner occupants are present, but was never the
// thing responsible for resolving unit-vs-unit combat — so the two systems
// combined produced a frozen capture bar sitting over a garrison stand-off
// that never actually fought, which (once one side eventually left to
// regroup rather than stand there forever) read to the user as capture
// alternating uncontested between the two sides. settleGarrisonCombat below
// is the missing periodic combat pass between stationary garrisons.
it("settleGarrisonCombat: two players' stationary garrisons in the same suburb actually trade hits, round after round, until one side is wiped out", () => {
  const { store, lobbyId, owner: lobbyOwner } = setup();
  const { playerId: p1 } = store.resolvePlayer(undefined);
  const { playerId: p2 } = store.resolvePlayer(undefined);
  // rng() = 0.5 -> damage = round(4 * (0.8 + 0.5*0.4)) = round(4) = 4 for a robot (damage 4).
  const units = createUnits(store.db, () => 0.5);
  units.placeUnit(lobbyId, p1, NON_ADJACENT_SAL_CODE, "robot"); // health 10
  units.placeUnit(lobbyId, p2, NON_ADJACENT_SAL_CODE, "robot"); // health 10

  // Nothing is "arriving" here — both units were placed directly, already
  // stationary — so settleArrivals (the old, only combat trigger) has
  // nothing to do.
  expect(units.settleArrivals(lobbyId)).toHaveLength(0);

  let kills = 0;
  let rounds = 0;
  for (let i = 0; i < 10; i++) {
    const outcomes = units.settleGarrisonCombat(lobbyId);
    if (outcomes.length === 0) break;
    rounds++;
    kills += outcomes.filter((o) => o.outcome === "kill").length;
    const remaining = units.getOccupancy(lobbyId).filter((u) => u.sal_code === NON_ADJACENT_SAL_CODE);
    if (new Set(remaining.map((u) => u.ownerPlayerId)).size < 2) break;
  }

  expect(rounds).toBeGreaterThan(1); // actually traded hits across multiple ticks, not resolved in one call
  expect(kills).toBe(1); // exactly one garrison wiped out -- the other survives as the sole occupant

  const remaining = units.getOccupancy(lobbyId).filter((u) => u.sal_code === NON_ADJACENT_SAL_CODE);
  const survivors = new Set(remaining.map((u) => u.ownerPlayerId));
  expect(survivors.size).toBe(1); // exactly one owner left standing, not an unresolved stand-off
  store.close();
});

it("settleGarrisonCombat: a single owner present is a no-op (uncontested accrual is territory.ts's job, not combat's)", () => {
  const { store, lobbyId, owner } = setup();
  const units = createUnits(store.db);
  units.placeUnit(lobbyId, owner, NON_ADJACENT_SAL_CODE, "drone");
  units.placeUnit(lobbyId, owner, NON_ADJACENT_SAL_CODE, "drone"); // same owner, two units -- still only one distinct owner present

  const outcomes = units.settleGarrisonCombat(lobbyId);
  expect(outcomes).toHaveLength(0);
  store.close();
});

it("settleGarrisonCombat: a suburb's own owner fights back against a lone invader standing in their territory (not left passive while capture ticks up)", () => {
  const { store, lobbyId, owner: lobbyOwner } = setup();
  const { playerId: defender } = store.resolvePlayer(undefined);
  const { playerId: invader } = store.resolvePlayer(undefined);
  const units = createUnits(store.db, () => 0.5);
  const territory = createTerritory(store.db);
  // Give `defender` registered ownership of NON_ADJACENT_SAL_CODE directly
  // (territory.ts's "capturers" filter excludes the registered owner, but
  // settleGarrisonCombat reasons from physical presence, not ownership).
  store.db
    .prepare("INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?)")
    .run(lobbyId, NON_ADJACENT_SAL_CODE, defender);

  units.placeUnit(lobbyId, defender, NON_ADJACENT_SAL_CODE, "robot");
  units.placeUnit(lobbyId, invader, NON_ADJACENT_SAL_CODE, "drone");

  const outcomes = units.settleGarrisonCombat(lobbyId);
  expect(outcomes.length).toBeGreaterThan(0);
  // The defender's own unit must be party to at least one of these outcomes
  // (either as the attacker, or -- if invader struck first in this round --
  // the defending robot's health reflects having taken a hit) rather than
  // sitting out its own invasion entirely.
  const defenderInvolved = outcomes.some(
    (o) =>
      (o.outcome === "hit" && (o.attacker.ownerPlayerId === defender || o.defender.ownerPlayerId === defender)) ||
      (o.outcome === "kill" && o.attacker.ownerPlayerId === defender),
  );
  expect(defenderInvolved).toBe(true);
  store.close();
});

it("settleGarrisonCombat: N=3 distinct owners present resolves without error and produces hits each round", () => {
  const { store, lobbyId } = setup();
  const { playerId: p1 } = store.resolvePlayer(undefined);
  const { playerId: p2 } = store.resolvePlayer(undefined);
  const { playerId: p3 } = store.resolvePlayer(undefined);
  const units = createUnits(store.db, () => 0.5);
  units.placeUnit(lobbyId, p1, NON_ADJACENT_SAL_CODE, "robot");
  units.placeUnit(lobbyId, p2, NON_ADJACENT_SAL_CODE, "robot");
  units.placeUnit(lobbyId, p3, NON_ADJACENT_SAL_CODE, "robot");

  const outcomes = units.settleGarrisonCombat(lobbyId);
  expect(outcomes.length).toBeGreaterThan(0);
  store.close();
});
