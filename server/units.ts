// Unit roster + combat (ANU-014), on top of ANU-013's minimal occupancy
// primitive. Two archetypes, matching the user's brief exactly: drones
// ("fly" — ignore adjacency/corridor, lower health/damage) and robots
// ("ground" — road-adjacent-to-owned-territory only, higher health/damage).
// Per issues/ANU-013.md's file-layout convention: server-side logic for
// this system lives in its own module.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { distanceBetweenSalCodes, getMapData, validSalCodes } from "./map-data.ts";
import { createPerkHook } from "./perks.ts";
import { elapsedMs, nowIso } from "./time.ts";
import type { OccupantUnit, UnitTypeCatalogEntry } from "./protocol.ts";

export type PlaceUnitResult =
  | { ok: true; unit: OccupantUnit }
  | { ok: false; reason: "unknown-suburb" | "unknown-unit-type" };

/**
 * Still a synchronous, instant single-unit reposition — unlike `moveUnits`
 * below, this is no longer reachable from the live WebSocket protocol
 * (ANU-027 replaced the old one-unit-at-a-time `moveUnit`/`attackSuburb`
 * messages with the bulk `moveUnits` message), so it was left out of
 * ANU-038's travel-time rework: nothing a player does can reach this path.
 * It stays as a direct-repositioning test primitive (spec/capture.test.ts
 * uses it to move a unit for ANU-017's capture-state-machine fixtures,
 * which are testing capture transitions, not movement mechanics) and
 * `attackSuburb` similarly stays a synchronous single-unit combat primitive
 * for spec/units.test.ts's seeded-rng assertions.
 */
export type MoveUnitResult =
  | { ok: true; unit: OccupantUnit }
  | { ok: false; reason: "unknown-suburb" | "not-found" | "not-owner" | "unreachable" | "suburb-defended" };

export type AttackOutcome =
  // Target held no enemy unit ("undefended" — see Notes in issues/ANU-014.md
  // for the exact definition) — the attack completes as a plain move.
  | { outcome: "moved"; unit: OccupantUnit }
  // Defender survived the hit; attacker stays put, both units remain.
  | { outcome: "hit"; attacker: OccupantUnit; defender: OccupantUnit; damageDealt: number }
  // Defender's health reached 0: it's destroyed, the attacker credits
  // scrap (scaled by the scrapPerKillMultiplier perk hook) and advances
  // into the now-vacated suburb.
  | { outcome: "kill"; attacker: OccupantUnit; destroyedUnitId: string; scrapCredited: number }
  // ANU-048: an "emp" unit's arrival ALWAYS detonates — bypasses
  // resolveCombatAt entirely (never fights a defender, never dies on
  // arrival), blacks out `sal_code`'s factory production/data-center TFLOPS
  // for EMP_BLACKOUT_DURATION_MS (server/territory.ts), then is consumed
  // (deleted). Distinct from "moved" — index.ts's settleArrivals relay
  // (server/index.ts) needs to tell these apart to know to re-broadcast
  // lobby state (the new empActiveUntil field lives there), which a plain
  // "moved" outcome never requires.
  | { outcome: "emp-detonated"; sal_code: string };

export type AttackSuburbResult =
  | ({ ok: true } & AttackOutcome)
  | { ok: false; reason: "unknown-suburb" | "not-found" | "not-owner" | "unreachable" };

/**
 * A Risk-style bulk order (ANU-027): move/attack with a declared count per
 * unit type, from one suburb the player has units in to a destination,
 * rather than one unitId at a time. Validated as a single all-or-nothing
 * batch — a request for more of a type than sit at `fromSalCode`, or for a
 * type that can't reach `toSalCode` at all, rejects the WHOLE order before
 * anything moves (no partial application), same "server stays authoritative
 * over a client-side courtesy check" precedent `attackSuburb` already
 * established for a single unit (issues/ANU-013.md's Notes).
 *
 * ANU-038: a valid order no longer resolves combat synchronously — it just
 * DISPATCHES every selected unit (marks it in-transit toward `toSalCode`,
 * stamping `destination_sal_code`/`move_started_at`). What happens to each
 * one (move/hit/kill) is decided later, on arrival, by `settleArrivals`
 * below, against whatever actually occupies `toSalCode` at that later
 * moment — confirmed with the user via AskUserQuestion (issues/ANU-038.md's
 * Notes) over resolving instantly at dispatch time with travel time only
 * delaying the visual.
 */
export type MoveUnitsResult =
  | { ok: true; dispatchedUnitIds: string[] }
  | { ok: false; reason: "unknown-suburb" | "unknown-unit-type" | "insufficient-units" | "unreachable" | "no-units-selected" };

export interface Units {
  placeUnit(lobbyId: string, ownerPlayerId: string, salCode: string, unitTypeKey: string): PlaceUnitResult;
  moveUnit(lobbyId: string, ownerPlayerId: string, unitId: string, salCode: string): MoveUnitResult;
  attackSuburb(lobbyId: string, ownerPlayerId: string, unitId: string, salCode: string): AttackSuburbResult;
  moveUnits(
    lobbyId: string,
    ownerPlayerId: string,
    fromSalCode: string,
    toSalCode: string,
    counts: Record<string, number>,
  ): MoveUnitsResult;
  /**
   * Resolves every unit in this lobby whose travel time (distance between
   * its origin `sal_code` and `destination_sal_code`, divided by its unit
   * type's `speed`) has elapsed since `move_started_at` — same
   * settle-lazily-at-read/broadcast-time shape as territory.ts's
   * settleCaptures/factories.ts's settle (ADR 0001: never an armed
   * per-unit timer). Resolves in `move_started_at`-then-`id` order across
   * the WHOLE lobby, not per-order, so two units racing for the same
   * contested suburb from different `moveUnits` calls resolve in the order
   * they'd actually arrive, each seeing the real effect of whichever
   * resolved just before it (issues/ANU-038.md's Notes).
   */
  settleArrivals(lobbyId: string): AttackOutcome[];
  getOccupancy(lobbyId: string): OccupantUnit[];
}

/**
 * Base unit-type rows, upserted idempotently at store boot rather than
 * seeded in ANU-013's migration — a migration runs once per schema
 * version, but both this issue (real stats) and ANU-016 (gated variant
 * rows) need to add/change unit_types rows after this issue merges,
 * without forcing either into its own colliding `PRAGMA user_version`
 * bump just to re-seed a row.
 *
 * Stats are a 2x ratio across the board (robot has double drone's health
 * and double its damage) in exchange for robot's movement being
 * adjacency-restricted — a real tradeoff, not a cosmetic one, and wide
 * enough that attackSuburb's +/-20% damage variance can't blur drone vs.
 * robot hits into the same range.
 *
 * `scrap_value` (ANU-022 rename of the old `build_cost_scrap`) no longer
 * gates building this type — units are free, auto-produced on a timer
 * (server/factories.ts) — but still sets how much scrap destroying one of
 * this type credits the killer (attackSuburb below), per PLAN.md's "scrap
 * earned by destroying enemy units."
 *
 * `speed` (ANU-038, map-units of map-geometry.json's label_point space per
 * game-ms — same "game-ms" scale `build_time_ms`/`CAPTURE_DURATION_MS`
 * already use, i.e. divided into real elapsed time via `elapsedMs`'s
 * GAME_TIME_SCALE) is what travelTimeMs below divides real suburb-to-suburb
 * distance by. Drone 2.5x robot's speed — not specified by the user's
 * request beyond "unit dependant" and "constant," so a ratio had to be
 * chosen: wide enough that a drone's flight and a robot's hop read as
 * genuinely different paces, in the same spirit as the 2x health/damage
 * split above, while keeping both archetypes' travel times in the same
 * rough order of magnitude as this file's other design durations (a 30s
 * drone build, a 20s capture) rather than either feeling instant or taking
 * several minutes for a routine adjacent move. At these values, the map's
 * median edge-length hop (~1945 map-units, scripts/map/data/map.json) takes
 * a drone ~4s and a robot ~10s; the full map's extreme diagonal
 * (~64000 map-units) takes a drone ~2 minutes.
 */
export const DRONE_SPEED = 0.5;
export const ROBOT_SPEED = 0.2;

/**
 * The "emp" unit_types row's key — gated by the "emp-research" skill node
 * (server/public/skill-tree-nodes.js), seeded idempotently alongside the
 * base roster below rather than in server/skill-tree.ts's
 * seedSkillGatedUnitTypes: an EMP isn't an upgraded variant of an existing
 * archetype (it has no "mk2" base to pair with), so it doesn't belong in
 * that drone-mk2/robot-mk2-specific seed function — it's its own archetype,
 * just gated the same `requires_skill_node` way those are.
 *
 * Stats (confirmed with the user via AskUserQuestion — issues/ANU-048.md's
 * Notes): health 1, damage 0 — "very fragile" while sitting idle at its
 * home suburb (dies to any hit, including a 20%-under-rolled drone hit via
 * resolveCombatAt's damage-variance roll) but never meaningfully fights
 * back if attacked before it ships out. It cannot be destroyed IN TRANSIT
 * at all — not because of its stats, but because settleArrivals' new
 * "emp" branch below bypasses resolveCombatAt entirely for an arriving EMP,
 * so health/damage only ever matter for an idle, not-yet-dispatched one.
 * `movement_mode: "fly"` — launchable to any territory, same unrestricted
 * reachability rule as a drone (the user's own "launchable to any
 * territory" request), not road-adjacency-gated like a robot. `speed`:
 * reuses DRONE_SPEED — no stated reason for an EMP to fly at a different
 * pace than a drone. `scrap_value`: a small amount, consistent with the
 * existing scrap-economy convention, credited to whoever kills an idle one.
 * `build_time_ms`: EMP_BUILD_TIME_MS below — by far the longest build in
 * the roster (next longest is robot's 2 minutes), so even a teched-up
 * player can only produce one every few minutes per factory, matching
 * "very hard to come by."
 */
export const EMP_UNIT_TYPE_KEY = "emp";
export const EMP_BUILD_TIME_MS = 300_000;
const EMP_HEALTH = 1;
const EMP_DAMAGE = 0;
const EMP_SCRAP_VALUE = 5;

export function seedBaseUnitTypes(db: DatabaseSync): void {
  const upsert = db.prepare(`
    INSERT INTO unit_types (key, health, damage, scrap_value, build_time_ms, movement_mode, speed, requires_skill_node)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(key) DO UPDATE SET
      health = excluded.health,
      damage = excluded.damage,
      scrap_value = excluded.scrap_value,
      build_time_ms = excluded.build_time_ms,
      movement_mode = excluded.movement_mode,
      speed = excluded.speed
  `);
  upsert.run("drone", 3, 2, 2, 30_000, "fly", DRONE_SPEED);
  upsert.run("robot", 10, 4, 4, 120_000, "ground", ROBOT_SPEED);

  // Gated (requires_skill_node), so it needs the ON CONFLICT branch to also
  // update that column — a plain re-run of this seed function must not
  // silently un-gate an already-gated row (or vice versa) if this value
  // ever changes.
  const upsertGated = db.prepare(`
    INSERT INTO unit_types (key, health, damage, scrap_value, build_time_ms, movement_mode, speed, requires_skill_node)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      health = excluded.health,
      damage = excluded.damage,
      scrap_value = excluded.scrap_value,
      build_time_ms = excluded.build_time_ms,
      movement_mode = excluded.movement_mode,
      speed = excluded.speed,
      requires_skill_node = excluded.requires_skill_node
  `);
  upsertGated.run(EMP_UNIT_TYPE_KEY, EMP_HEALTH, EMP_DAMAGE, EMP_SCRAP_VALUE, EMP_BUILD_TIME_MS, "fly", DRONE_SPEED, "emp-research");
}

/**
 * Every unit_types row, for the client's unit catalog (ANU-020, repurposed
 * by ANU-022 from a build-cost listing to a stats-only reference now that
 * units aren't individually built/bought) — a plain export rather than a
 * method on `Units`, same convention as seedBaseUnitTypes above, since it's
 * reference data with no per-lobby state to close over.
 */
export function listUnitTypes(db: DatabaseSync): UnitTypeCatalogEntry[] {
  const rows = db
    .prepare(
      `SELECT key, health, damage, scrap_value AS scrapValue, build_time_ms AS buildTimeMs,
              movement_mode AS movementMode, speed, requires_skill_node AS requiresSkillNode
       FROM unit_types`,
    )
    .all();
  return rows as unknown as UnitTypeCatalogEntry[];
}

interface UnitTypeRow {
  health: number;
  damage: number;
  scrap_value: number;
  movement_mode: "fly" | "ground";
  speed: number;
}

interface UnitRow {
  id: string;
  ownerPlayerId: string;
  salCode: string;
  unitTypeKey: string;
  health: number;
  /** Present only on a row read via a query that selects them — absent (not just null) on a query that doesn't, e.g. selectOwnedUnitsOfTypeAt. */
  destinationSalCode?: string | null;
  moveStartedAt?: string | null;
}

interface OccupantRow extends UnitRow {
  spawnedAt: string;
}

/**
 * sal_code -> road-adjacent sal_codes, built once from the same static
 * map.json units.ts already reads for suburb validity (map-data.ts) —
 * not added to map-data.ts itself, since other ANU-013-downstream
 * branches (territory.ts/factories.ts/skill-tree.ts) also touch that
 * module and a shared new export risks a collision across the four
 * parallel worktrees (docs/git-workflow.md rule 4).
 */
function buildAdjacency(): Map<string, Set<string>> {
  const { suburbs, edges } = getMapData();
  const idxToSalCode = new Map(suburbs.map((s) => [s.idx, s.sal_code]));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const a = idxToSalCode.get(edge.a);
    const b = idxToSalCode.get(edge.b);
    if (!a || !b) continue;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  return adjacency;
}

const adjacency = buildAdjacency();

/**
 * A "ground" (robot) unit may reach a suburb it already owns, or one
 * road-adjacent to a suburb it owns — owned-but-not-yet-adjacent-to-
 * anything-else suburbs (e.g. an isolated spawn) must stay reachable by
 * their own owner, so "owned" alone has to count, not just "neighbour of
 * owned".
 */
function groundCanReach(ownedSalCodes: ReadonlySet<string>, target: string): boolean {
  if (ownedSalCodes.has(target)) return true;
  const neighbours = adjacency.get(target);
  if (!neighbours) return false;
  for (const n of neighbours) {
    if (ownedSalCodes.has(n)) return true;
  }
  return false;
}

export function createUnits(db: DatabaseSync, rng: () => number = Math.random): Units {
  const perks = createPerkHook(db);

  const selectUnitType = db.prepare(
    "SELECT health, damage, scrap_value, movement_mode, speed FROM unit_types WHERE key = ?",
  );
  const insertUnit = db.prepare(`
    INSERT INTO units (id, lobby_id, owner_player_id, sal_code, unit_type_key, health, spawned_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  const selectUnit = db.prepare(
    "SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health FROM units WHERE id = ? AND lobby_id = ?",
  );
  // ANU-038: a completed arrival ("moved"/"kill") both relocates the unit
  // AND clears its transit stamps in one statement — a "hit" outcome
  // (stayPut below) clears the stamps without touching sal_code, since the
  // attacker stays put at its ORIGIN, not the contested destination.
  const arriveUnit = db.prepare("UPDATE units SET sal_code = ?, destination_sal_code = NULL, move_started_at = NULL WHERE id = ?");
  const stayPut = db.prepare("UPDATE units SET destination_sal_code = NULL, move_started_at = NULL WHERE id = ?");
  const updateUnitHealth = db.prepare("UPDATE units SET health = ? WHERE id = ?");
  const deleteUnit = db.prepare("DELETE FROM units WHERE id = ?");
  // ANU-048: writes/refreshes an EMP blackout on arrival — same upsert shape
  // as server/territory.ts's own upsertEmpStrike (this module can't import
  // that module's closure-private statement, and duplicating one `ON
  // CONFLICT` upsert here is cheaper than threading a Territory dependency
  // through createUnits' signature and every existing spec/*.test.ts call
  // site that constructs one). Always overwrites emp_started_at to now,
  // which is the confirmed refresh-not-stack re-strike rule — no separate
  // "already active" branch needed.
  const upsertEmpStrike = db.prepare(`
    INSERT INTO suburb_ownership (lobby_id, sal_code, emp_started_at)
    VALUES (?, ?, ?)
    ON CONFLICT(lobby_id, sal_code) DO UPDATE SET emp_started_at = excluded.emp_started_at
  `);
  const selectOccupancy = db.prepare(`
    SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health,
           destination_sal_code AS destinationSalCode, move_started_at AS moveStartedAt
    FROM units WHERE lobby_id = ?
  `);
  // Stable order (spawned_at, then id to break ties) so attackSuburb always
  // resolves against the same defender for the same occupancy state —
  // required for the chosen combat rule's damage-variance tests to be
  // reproducible under a seeded rng. Excludes units currently in transit
  // (ANU-038: `destination_sal_code IS NULL`) — a unit mid-flight away from
  // its origin no longer defends there, and a unit mid-flight toward this
  // suburb hasn't arrived yet, so neither counts as "occupying" it.
  const selectOccupantsAt = db.prepare(`
    SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health, spawned_at AS spawnedAt
    FROM units WHERE lobby_id = ? AND sal_code = ? AND destination_sal_code IS NULL
    ORDER BY spawned_at, id
  `);
  const selectOwnedSalCodes = db.prepare(
    "SELECT sal_code AS salCode FROM suburb_ownership WHERE lobby_id = ? AND owner_player_id = ?",
  );
  const creditScrap = db.prepare("UPDATE lobby_members SET scrap = scrap + ? WHERE lobby_id = ? AND player_id = ?");
  // Same stable spawn-order tie-break as selectOccupantsAt — a moveUnits
  // order sends the player's OLDEST units of a type first, so which
  // individual units go matters only for the "whose turn is next" order
  // ANU-027's combat-per-unit-in-order rule reads, not for anything else.
  // Also excludes units already in transit (ANU-038) — an in-flight unit
  // can't be dispatched again until it arrives.
  const selectOwnedUnitsOfTypeAt = db.prepare(`
    SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health, spawned_at AS spawnedAt
    FROM units WHERE lobby_id = ? AND sal_code = ? AND owner_player_id = ? AND unit_type_key = ? AND destination_sal_code IS NULL
    ORDER BY spawned_at, id
  `);
  const startTransit = db.prepare("UPDATE units SET destination_sal_code = ?, move_started_at = ? WHERE id = ?");
  // Lobby-wide (not per-order) stable order by move_started_at-then-id, so
  // `settleArrivals` resolves two units racing for the same contested
  // suburb from two DIFFERENT moveUnits orders in the order they'd actually
  // arrive — see issues/ANU-038.md's Notes on why this can't be scoped
  // per-order the way ANU-027's combat-per-unit-in-order rule is.
  const selectInTransit = db.prepare(`
    SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health,
           destination_sal_code AS destinationSalCode, move_started_at AS moveStartedAt
    FROM units WHERE lobby_id = ? AND destination_sal_code IS NOT NULL
    ORDER BY move_started_at, id
  `);

  function toOccupant(row: UnitRow): OccupantUnit {
    if (!row.destinationSalCode) {
      return { id: row.id, ownerPlayerId: row.ownerPlayerId, sal_code: row.salCode, unitTypeKey: row.unitTypeKey, health: row.health };
    }
    // travelProgressFraction is computed here (not stored) so it's always
    // fresh at broadcast time, same derived-at-read-time pattern
    // territory.ts's progressFraction/factories.ts's progressFraction use —
    // never trusted from a stale prior broadcast.
    const unitType = selectUnitType.get(row.unitTypeKey) as unknown as UnitTypeRow;
    const distance = distanceBetweenSalCodes(row.salCode, row.destinationSalCode);
    const travelTimeMs = unitType.speed > 0 ? distance / unitType.speed : 0;
    const travelProgressFraction = travelTimeMs > 0 ? Math.max(0, Math.min(1, elapsedMs(row.moveStartedAt) / travelTimeMs)) : 1;
    return {
      id: row.id,
      ownerPlayerId: row.ownerPlayerId,
      sal_code: row.salCode,
      unitTypeKey: row.unitTypeKey,
      health: row.health,
      destinationSalCode: row.destinationSalCode,
      moveStartedAt: row.moveStartedAt ?? undefined,
      travelProgressFraction,
    };
  }

  function ownedSalCodes(lobbyId: string, playerId: string): Set<string> {
    return new Set((selectOwnedSalCodes.all(lobbyId, playerId) as { salCode: string }[]).map((r) => r.salCode));
  }

  /** The reachability half of both moveUnit and attackSuburb — identical rule for both per issues/ANU-014.md. */
  function canReach(lobbyId: string, ownerPlayerId: string, unitType: UnitTypeRow, target: string): boolean {
    if (unitType.movement_mode === "fly") return true; // drones ignore adjacency/corridor entirely
    return groundCanReach(ownedSalCodes(lobbyId, ownerPlayerId), target);
  }

  /**
   * The combat-resolution core, independent of how the attacker got
   * permission to act on `salCode` — shared by `attackSuburbImpl` (which
   * checks ownership/reachability itself, for the instant single-unit
   * primitive) and `settleArrivals` (ANU-038), which deliberately does NOT
   * re-check reachability for an already-in-flight unit: a unit that was
   * reachable and owned at dispatch time stays committed to its trip even
   * if, say, the destination's ownership shifts mid-flight — only an
   * enemy's defending PRESENCE (not reachability) should ever change what
   * happens on arrival.
   */
  function resolveCombatAt(lobbyId: string, ownerPlayerId: string, row: UnitRow, salCode: string): AttackOutcome {
    // Resolving combat always ends this unit's transit, win or lose — strip
    // any destinationSalCode/moveStartedAt `row` carries (settleArrivals'
    // callers read it from the in-transit query) before building the
    // OccupantUnit this function returns, so a "hit" outcome's attacker
    // doesn't echo stale in-transit fields the DB writes below just cleared.
    const settled: UnitRow = { ...row, destinationSalCode: undefined, moveStartedAt: undefined };
    const attackerType = selectUnitType.get(row.unitTypeKey) as unknown as UnitTypeRow;
    const occupants = (selectOccupantsAt.all(lobbyId, salCode) as unknown as OccupantRow[]).filter((o) => o.id !== row.id);
    const defenders = occupants.filter((o) => o.ownerPlayerId !== ownerPlayerId);

    // "Undefended" (issues/ANU-014.md): no unit owned by anyone other
    // than the attacker currently occupies the target — true whether the
    // suburb is neutral, owned by the attacker, or even enemy-owned with
    // no units garrisoned there. Capturing ownership itself is ANU-017's
    // job; this just lets the attacking unit advance into it.
    if (defenders.length === 0) {
      arriveUnit.run(salCode, row.id);
      return { outcome: "moved", unit: toOccupant({ ...settled, salCode }) };
    }

    const defender = defenders[0]; // stable spawn order — see selectOccupantsAt
    const defenderType = selectUnitType.get(defender.unitTypeKey) as unknown as UnitTypeRow;

    // Random-element resolution (confirmed with the user over
    // AskUserQuestion — see issues/ANU-014.md Resolution): damage is the
    // attacker's base damage scaled by a uniform +/-20% roll, floored at
    // 1 so a hit is never a complete whiff. `rng` is injectable so
    // spec/*.test.ts can assert an exact outcome under a seeded sequence.
    const damageDealt = Math.max(1, Math.round(attackerType.damage * (0.8 + rng() * 0.4)));
    const remainingHealth = defender.health - damageDealt;

    if (remainingHealth > 0) {
      updateUnitHealth.run(remainingHealth, defender.id);
      // The attacker stays at its ORIGIN, not the contested destination —
      // for the instant `attackSuburb` primitive that's already `row`'s
      // sal_code, a no-op; for an arriving unit (settleArrivals below) this
      // also clears its now-finished transit stamps, same as a "moved"/
      // "kill" arrival, just without relocating it.
      stayPut.run(row.id);
      return {
        outcome: "hit",
        attacker: toOccupant(settled),
        defender: toOccupant({ ...defender, health: remainingHealth }),
        damageDealt,
      };
    }

    deleteUnit.run(defender.id);
    const scrapPerKillMultiplier = perks.getPerkMultipliers(lobbyId, ownerPlayerId).scrapPerKillMultiplier;
    const scrapCredited = Math.round(defenderType.scrap_value * scrapPerKillMultiplier);
    creditScrap.run(scrapCredited, lobbyId, ownerPlayerId);
    arriveUnit.run(salCode, row.id); // the attacker advances into the suburb it just cleared
    return {
      outcome: "kill",
      attacker: toOccupant({ ...settled, salCode }),
      destroyedUnitId: defender.id,
      scrapCredited,
    };
  }

  /**
   * The instant single-unit move/attack primitive (spec/units.test.ts's
   * seeded-rng assertions, spec/capture.test.ts's capture-state fixtures —
   * see MoveUnitResult's docstring on why this is still a synchronous path
   * even though no live message reaches it anymore). Checks ownership and
   * reachability itself, then delegates to resolveCombatAt.
   */
  function attackSuburbImpl(lobbyId: string, ownerPlayerId: string, unitId: string, salCode: string): AttackSuburbResult {
    if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
    const row = selectUnit.get(unitId, lobbyId) as UnitRow | undefined;
    if (!row) return { ok: false, reason: "not-found" };
    if (row.ownerPlayerId !== ownerPlayerId) return { ok: false, reason: "not-owner" };

    const attackerType = selectUnitType.get(row.unitTypeKey) as unknown as UnitTypeRow;
    if (!canReach(lobbyId, ownerPlayerId, attackerType, salCode)) return { ok: false, reason: "unreachable" };

    return { ok: true, ...resolveCombatAt(lobbyId, ownerPlayerId, row, salCode) };
  }

  return {
    placeUnit(lobbyId, ownerPlayerId, salCode, unitTypeKey) {
      if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
      const unitType = selectUnitType.get(unitTypeKey) as UnitTypeRow | undefined;
      if (!unitType) return { ok: false, reason: "unknown-unit-type" };

      // Deliberately still "any suburb" here, not drone/robot reachability
      // — ANU-017's capture-contest specs place a contesting unit directly
      // into a suburb regardless of adjacency, and that issue runs as a
      // parallel worktree against this one. See issues/ANU-014.md Notes:
      // this is a loophole (a robot can be *placed* somewhere it couldn't
      // walk to) left for ANU-015's factories to close, since a factory
      // only ever places a unit at its own suburb anyway.
      const id = randomUUID();
      insertUnit.run(id, lobbyId, ownerPlayerId, salCode, unitTypeKey, unitType.health);
      return { ok: true, unit: { id, ownerPlayerId, sal_code: salCode, unitTypeKey, health: unitType.health } };
    },

    moveUnit(lobbyId, ownerPlayerId, unitId, salCode) {
      if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
      const row = selectUnit.get(unitId, lobbyId) as UnitRow | undefined;
      if (!row) return { ok: false, reason: "not-found" };
      if (row.ownerPlayerId !== ownerPlayerId) return { ok: false, reason: "not-owner" };

      const unitType = selectUnitType.get(row.unitTypeKey) as unknown as UnitTypeRow;
      if (!canReach(lobbyId, ownerPlayerId, unitType, salCode)) return { ok: false, reason: "unreachable" };

      const occupants = selectOccupantsAt.all(lobbyId, salCode) as unknown as OccupantRow[];
      const enemyPresent = occupants.some((o) => o.id !== unitId && o.ownerPlayerId !== ownerPlayerId);
      if (enemyPresent) return { ok: false, reason: "suburb-defended" }; // use attackSuburb instead

      arriveUnit.run(salCode, unitId);
      return { ok: true, unit: toOccupant({ ...row, salCode }) };
    },

    attackSuburb(lobbyId, ownerPlayerId, unitId, salCode) {
      return attackSuburbImpl(lobbyId, ownerPlayerId, unitId, salCode);
    },

    moveUnits(lobbyId, ownerPlayerId, fromSalCode, toSalCode, counts) {
      if (!validSalCodes.has(fromSalCode) || !validSalCodes.has(toSalCode)) {
        return { ok: false, reason: "unknown-suburb" };
      }

      // Validate the whole order up front — reachability and stock are
      // checked for EVERY requested type before any unit actually moves, so
      // a bad order never partially applies (issues/ANU-027.md's "done
      // when": requesting more robots than can reach rejects the whole
      // order, not just the robots).
      const unitIdsInOrder: string[] = [];
      for (const [unitTypeKey, rawCount] of Object.entries(counts)) {
        const count = Math.trunc(rawCount);
        if (count <= 0) continue;

        const unitType = selectUnitType.get(unitTypeKey) as UnitTypeRow | undefined;
        if (!unitType) return { ok: false, reason: "unknown-unit-type" };
        if (!canReach(lobbyId, ownerPlayerId, unitType, toSalCode)) return { ok: false, reason: "unreachable" };

        const available = selectOwnedUnitsOfTypeAt.all(lobbyId, fromSalCode, ownerPlayerId, unitTypeKey) as unknown as OccupantRow[];
        if (available.length < count) return { ok: false, reason: "insufficient-units" };

        for (let i = 0; i < count; i++) unitIdsInOrder.push(available[i].id);
      }

      if (unitIdsInOrder.length === 0) return { ok: false, reason: "no-units-selected" };

      // ANU-038: dispatch only — stamp destination/start time, no combat
      // decided here. `fromSalCode`/`toSalCode` were both validated above,
      // so distanceBetweenSalCodes always resolves a real distance; the
      // unit's own sal_code stays `fromSalCode` (its ORIGIN) until
      // settleArrivals relocates or releases it.
      const startedAt = nowIso();
      for (const unitId of unitIdsInOrder) {
        startTransit.run(toSalCode, startedAt, unitId);
      }

      return { ok: true, dispatchedUnitIds: unitIdsInOrder };
    },

    settleArrivals(lobbyId) {
      const inTransit = selectInTransit.all(lobbyId) as unknown as (UnitRow & { destinationSalCode: string; moveStartedAt: string })[];
      const outcomes: AttackOutcome[] = [];
      for (const unit of inTransit) {
        const unitType = selectUnitType.get(unit.unitTypeKey) as unknown as UnitTypeRow;
        const distance = distanceBetweenSalCodes(unit.salCode, unit.destinationSalCode);
        const travelTimeMs = unitType.speed > 0 ? distance / unitType.speed : 0;
        if (elapsedMs(unit.moveStartedAt) < travelTimeMs) continue; // still travelling

        // ANU-048: an "emp" unit's arrival ALWAYS detonates — checked before
        // (never falls through to) the defended/undefended combat logic
        // below. It never fights a defender present at the destination,
        // never dies on arrival, and is consumed regardless of who or what
        // is garrisoned there (confirmed with the user via AskUserQuestion
        // — issues/ANU-048.md's Notes: a payload, not a combatant).
        if (unit.unitTypeKey === EMP_UNIT_TYPE_KEY) {
          deleteUnit.run(unit.id);
          upsertEmpStrike.run(lobbyId, unit.destinationSalCode, nowIso());
          outcomes.push({ outcome: "emp-detonated", sal_code: unit.destinationSalCode });
          continue;
        }

        // Resolves against the destination's ACTUAL occupants right now,
        // not whatever was there when this unit was dispatched — a
        // defender may have reinforced or retreated mid-flight (confirmed
        // with the user via AskUserQuestion; issues/ANU-038.md's Notes).
        // Deliberately resolveCombatAt, not attackSuburbImpl — reachability
        // was already checked once at dispatch time and must not be
        // re-checked here (see resolveCombatAt's docstring).
        outcomes.push(resolveCombatAt(lobbyId, unit.ownerPlayerId, unit, unit.destinationSalCode));
      }
      return outcomes;
    },

    getOccupancy(lobbyId) {
      const rows = selectOccupancy.all(lobbyId) as unknown as UnitRow[];
      return rows.map(toOccupant);
    },
  };
}
