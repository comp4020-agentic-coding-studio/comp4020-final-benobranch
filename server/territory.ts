// Suburb ownership (ANU-013 schema/kickoff-assignment; ANU-017 owns the
// capture state machine that reads/writes the same table's capture-state
// columns). Per issues/ANU-013.md's file-layout convention: server-side
// logic for this system lives in its own module.
import type { DatabaseSync } from "node:sqlite";
import { spawnSalCodesForCapacity } from "./map-data.ts";

export interface Territory {
  /**
   * Spawn suburbs auto-owned at kickoff: `startLobby` calls this once, right
   * after the lobby's `started`/`startedAt` flip, so troops/factories/
   * capture all start from a non-empty ownership state instead of an
   * all-neutral map. Members are assigned spawns in join order (the same
   * stable order server/store.ts's getLobbyMembers now guarantees via
   * joined_at) against the spawn table entry for the ACTUAL player count —
   * not the lobby's configured capacity. PLAN.md: "spawns are computed per
   * lobby from its player count" — a 12-capacity lobby started with only
   * the 4-player minimum must use the 4-player spawn ring (a tight, roughly
   * balanced set for 4), not the first 4 entries of the 12-player ring
   * (which clusters however that ring happens to start).
   */
  assignSpawnOwnership(lobbyId: string, memberPlayerIds: string[]): void;
  getOwnership(lobbyId: string): Record<string, string>;
}

export function createTerritory(db: DatabaseSync): Territory {
  const upsertOwner = db.prepare(`
    INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id)
    VALUES (?, ?, ?)
    ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id
  `);
  const selectOwnership = db.prepare(
    "SELECT sal_code AS salCode, owner_player_id AS ownerPlayerId FROM suburb_ownership WHERE lobby_id = ? AND owner_player_id IS NOT NULL",
  );
  // ANU-025: records each player's kickoff spawn suburb separately from
  // suburb_ownership (which mutates on every later capture) — this is what
  // lets a player's base marker disappear once that suburb changes hands,
  // rather than silently tracking wherever they currently hold territory.
  const setSpawnSalCode = db.prepare(
    "UPDATE lobby_members SET spawn_sal_code = ? WHERE lobby_id = ? AND player_id = ?",
  );

  return {
    assignSpawnOwnership(lobbyId, memberPlayerIds) {
      // MIN_CAPACITY/MAX_CAPACITY (4-12) bound the spawn table's keys —
      // clamp defensively rather than trust the caller's count is in range.
      const n = Math.max(4, Math.min(12, memberPlayerIds.length));
      const spawnSalCodes = spawnSalCodesForCapacity(n);
      if (!spawnSalCodes) return; // no spawn table entry for this player count — nothing to assign
      const assignable = Math.min(spawnSalCodes.length, memberPlayerIds.length);
      for (let i = 0; i < assignable; i++) {
        upsertOwner.run(lobbyId, spawnSalCodes[i], memberPlayerIds[i]);
        setSpawnSalCode.run(spawnSalCodes[i], lobbyId, memberPlayerIds[i]);
      }
    },

    getOwnership(lobbyId) {
      const rows = selectOwnership.all(lobbyId) as { salCode: string; ownerPlayerId: string }[];
      const result: Record<string, string> = {};
      for (const row of rows) result[row.salCode] = row.ownerPlayerId;
      return result;
    },
  };
}
