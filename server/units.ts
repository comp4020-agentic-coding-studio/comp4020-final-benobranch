// Minimal occupancy primitive (ANU-013) — placeUnit/moveUnit with a
// placeholder "any real suburb" eligibility check. ANU-014 replaces that
// check with real adjacency/flight rules without changing this module's
// exported shape, so ANU-017's capture-state specs can put a contesting
// unit into a suburb without waiting on ANU-014 to exist. Per
// issues/ANU-013.md's file-layout convention: server-side logic for this
// system lives in its own module.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { validSalCodes } from "./map-data.ts";
import type { OccupantUnit } from "./protocol.ts";

export type PlaceUnitResult =
  | { ok: true; unit: OccupantUnit }
  | { ok: false; reason: "unknown-suburb" | "unknown-unit-type" };

export type MoveUnitResult =
  | { ok: true; unit: OccupantUnit }
  | { ok: false; reason: "unknown-suburb" | "not-found" | "not-owner" };

export interface Units {
  placeUnit(lobbyId: string, ownerPlayerId: string, salCode: string, unitTypeKey: string): PlaceUnitResult;
  moveUnit(lobbyId: string, ownerPlayerId: string, unitId: string, salCode: string): MoveUnitResult;
  getOccupancy(lobbyId: string): OccupantUnit[];
}

export function createUnits(db: DatabaseSync): Units {
  const selectUnitType = db.prepare("SELECT health FROM unit_types WHERE key = ?");
  const insertUnit = db.prepare(`
    INSERT INTO units (id, lobby_id, owner_player_id, sal_code, unit_type_key, health, spawned_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);
  const selectUnit = db.prepare(
    "SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health FROM units WHERE id = ? AND lobby_id = ?",
  );
  const updateUnitSalCode = db.prepare("UPDATE units SET sal_code = ? WHERE id = ?");
  const selectOccupancy = db.prepare(
    "SELECT id, owner_player_id AS ownerPlayerId, sal_code AS salCode, unit_type_key AS unitTypeKey, health FROM units WHERE lobby_id = ?",
  );

  function toOccupant(row: {
    id: string;
    ownerPlayerId: string;
    salCode: string;
    unitTypeKey: string;
    health: number;
  }): OccupantUnit {
    return { id: row.id, ownerPlayerId: row.ownerPlayerId, sal_code: row.salCode, unitTypeKey: row.unitTypeKey, health: row.health };
  }

  return {
    placeUnit(lobbyId, ownerPlayerId, salCode, unitTypeKey) {
      if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
      const unitType = selectUnitType.get(unitTypeKey) as { health: number } | undefined;
      if (!unitType) return { ok: false, reason: "unknown-unit-type" };

      const id = randomUUID();
      insertUnit.run(id, lobbyId, ownerPlayerId, salCode, unitTypeKey, unitType.health);
      return { ok: true, unit: { id, ownerPlayerId, sal_code: salCode, unitTypeKey, health: unitType.health } };
    },

    moveUnit(lobbyId, ownerPlayerId, unitId, salCode) {
      if (!validSalCodes.has(salCode)) return { ok: false, reason: "unknown-suburb" };
      const row = selectUnit.get(unitId, lobbyId) as
        | { id: string; ownerPlayerId: string; salCode: string; unitTypeKey: string; health: number }
        | undefined;
      if (!row) return { ok: false, reason: "not-found" };
      if (row.ownerPlayerId !== ownerPlayerId) return { ok: false, reason: "not-owner" };

      updateUnitSalCode.run(salCode, unitId);
      return { ok: true, unit: toOccupant({ ...row, salCode }) };
    },

    getOccupancy(lobbyId) {
      const rows = selectOccupancy.all(lobbyId) as {
        id: string;
        ownerPlayerId: string;
        salCode: string;
        unitTypeKey: string;
        health: number;
      }[];
      return rows.map(toOccupant);
    },
  };
}
