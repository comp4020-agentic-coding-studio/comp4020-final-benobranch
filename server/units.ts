// Unit roster + combat (ANU-014), on top of ANU-013's minimal occupancy
// primitive. Two archetypes, matching the user's brief exactly: drones
// ("fly" — ignore adjacency/corridor, lower health/damage) and robots
// ("ground" — road-adjacent-to-owned-territory only, higher health/damage).
// Per issues/ANU-013.md's file-layout convention: server-side logic for
// this system lives in its own module.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { getMapData, validSalCodes } from "./map-data.ts";
import { createPerkHook } from "./perks.ts";
import type { OccupantUnit, UnitTypeCatalogEntry } from "./protocol.ts";

export type PlaceUnitResult =
  | { ok: true; unit: OccupantUnit }
  | { ok: false; reason: "unknown-suburb" | "unknown-unit-type" };

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
  | { outcome: "kill"; attacker: OccupantUnit; destroyedUnitId: string; scrapCredited: number };

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
 * established for a single unit (issues/ANU-013.md's Notes). Once validated,
 * each selected unit resolves via the same per-unit `attackSuburb` combat
 * rule, oldest-spawned first within each type, in `counts`' own key order —
 * a unit lost mid-order (its type's attacker killed before its turn) simply
 * doesn't get a turn; there's no separate bulk-combat formula.
 */
export type MoveUnitsResult =
  | { ok: true; outcomes: AttackOutcome[] }
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
 */
export function seedBaseUnitTypes(db: DatabaseSync): void {
  const upsert = db.prepare(`
    INSERT INTO unit_types (key, health, damage, scrap_value, build_time_ms, movement_mode, requires_skill_node)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(key) DO UPDATE SET
      health = excluded.health,
      damage = excluded.damage,
      scrap_value = excluded.scrap_value,
      build_time_ms = excluded.build_time_ms,
      movement_mode = excluded.movement_mode
  `);
  upsert.run("drone", 3, 2, 2, 30_000, "fly");
  upsert.run("robot", 10, 4, 4, 120_000, "ground");
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
              movement_mode AS movementMode, requires_skill_node AS requiresSkillNode
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
}

interface UnitRow {
  id: string;
  ownerPlayerId: string;
  salCode: string;
  unitTypeKey: string;
  health: number;
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
    "SELECT health, damage, scrap_value, movement_mode FROM unit_types WHERE key = ?",
  );
  const insertUnit = db.prepare(`
    INSERT INTO units (id, lobby_id, owner_player_id, sal_code, unit_type_key, health, spawned_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  const selectUnit = db.prepare(
    "SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health FROM units WHERE id = ? AND lobby_id = ?",
  );
  const updateUnitSalCode = db.prepare("UPDATE units SET sal_code = ? WHERE id = ?");
  const updateUnitHealth = db.prepare("UPDATE units SET health = ? WHERE id = ?");
  const deleteUnit = db.prepare("DELETE FROM units WHERE id = ?");
  const selectOccupancy = db.prepare(
    "SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health FROM units WHERE lobby_id = ?",
  );
  // Stable order (spawned_at, then id to break ties) so attackSuburb always
  // resolves against the same defender for the same occupancy state —
  // required for the chosen combat rule's damage-variance tests to be
  // reproducible under a seeded rng.
  const selectOccupantsAt = db.prepare(`
    SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health, spawned_at AS spawnedAt
    FROM units WHERE lobby_id = ? AND sal_code = ?
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
  const selectOwnedUnitsOfTypeAt = db.prepare(`
    SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health, spawned_at AS spawnedAt
    FROM units WHERE lobby_id = ? AND sal_code = ? AND owner_player_id = ? AND unit_type_key = ?
    ORDER BY spawned_at, id
  `);

  function toOccupant(row: UnitRow): OccupantUnit {
    return { id: row.id, ownerPlayerId: row.ownerPlayerId, sal_code: row.salCode, unitTypeKey: row.unitTypeKey, health: row.health };
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
   * The actual per-unit move/attack-and-resolve-combat logic — extracted
   * from the public `attackSuburb` method (same closure-extraction pattern
   * as `canReach`/`ownedSalCodes` above) so `moveUnits` (ANU-027) can run it
   * once per selected unit without going through a second ownership/
   * reachability re-check keyed off reading back the player's own
   * just-selected unit, and without duplicating the combat resolution.
   */
  function attackSuburbImpl(lobbyId: string, ownerPlayerId: string, unitId: string, salCode: string): AttackSuburbResult {
    if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
    const row = selectUnit.get(unitId, lobbyId) as UnitRow | undefined;
    if (!row) return { ok: false, reason: "not-found" };
    if (row.ownerPlayerId !== ownerPlayerId) return { ok: false, reason: "not-owner" };

    const attackerType = selectUnitType.get(row.unitTypeKey) as unknown as UnitTypeRow;
    if (!canReach(lobbyId, ownerPlayerId, attackerType, salCode)) return { ok: false, reason: "unreachable" };

    const occupants = (selectOccupantsAt.all(lobbyId, salCode) as unknown as OccupantRow[]).filter((o) => o.id !== unitId);
    const defenders = occupants.filter((o) => o.ownerPlayerId !== ownerPlayerId);

    // "Undefended" (issues/ANU-014.md): no unit owned by anyone other
    // than the attacker currently occupies the target — true whether the
    // suburb is neutral, owned by the attacker, or even enemy-owned with
    // no units garrisoned there. Capturing ownership itself is ANU-017's
    // job; this just lets the attacking unit advance into it.
    if (defenders.length === 0) {
      updateUnitSalCode.run(salCode, unitId);
      return { ok: true, outcome: "moved", unit: toOccupant({ ...row, salCode }) };
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
      return {
        ok: true,
        outcome: "hit",
        attacker: toOccupant(row),
        defender: toOccupant({ ...defender, health: remainingHealth }),
        damageDealt,
      };
    }

    deleteUnit.run(defender.id);
    const scrapPerKillMultiplier = perks.getPerkMultipliers(lobbyId, ownerPlayerId).scrapPerKillMultiplier;
    const scrapCredited = Math.round(defenderType.scrap_value * scrapPerKillMultiplier);
    creditScrap.run(scrapCredited, lobbyId, ownerPlayerId);
    updateUnitSalCode.run(salCode, unitId); // the attacker advances into the suburb it just cleared
    return {
      ok: true,
      outcome: "kill",
      attacker: toOccupant({ ...row, salCode }),
      destroyedUnitId: defender.id,
      scrapCredited,
    };
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

      updateUnitSalCode.run(salCode, unitId);
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

      // Each selected unit resolves via the same per-unit attackSuburb rule,
      // in order — a hit that kills an earlier unit in this order doesn't
      // stop later ones from still getting their own turn (issues/ANU-027.md:
      // "no new bulk-combat formula"). Every unitId here was just confirmed
      // owned-and-present-at-fromSalCode above, and reachability was already
      // checked per type, so attackSuburbImpl's own checks can't fail here
      // except by the target suburb's occupants changing between selected
      // units within this same order (e.g. an earlier unit's kill clearing
      // the way, or a later unit facing a fresh defender) — exactly the
      // live combat resolution this rule intends.
      const outcomes: AttackOutcome[] = [];
      for (const unitId of unitIdsInOrder) {
        const result = attackSuburbImpl(lobbyId, ownerPlayerId, unitId, toSalCode);
        if (result.ok) outcomes.push(result);
      }

      return { ok: true, outcomes };
    },

    getOccupancy(lobbyId) {
      const rows = selectOccupancy.all(lobbyId) as unknown as UnitRow[];
      return rows.map(toOccupant);
    },
  };
}
