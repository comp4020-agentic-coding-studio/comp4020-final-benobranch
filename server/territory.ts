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
   * joined_at) against the spawn table's own order, for a lobby of this
   * exact capacity.
   */
  assignSpawnOwnership(lobbyId: string, capacity: number, memberPlayerIds: string[]): void;
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

  return {
    assignSpawnOwnership(lobbyId, capacity, memberPlayerIds) {
      const spawnSalCodes = spawnSalCodesForCapacity(capacity);
      if (!spawnSalCodes) return; // no spawn table entry for this capacity — nothing to assign
      // Capacity can exceed the recorded member count in edge cases (e.g. a
      // lobby started below its own capacity isn't possible per PLAN.md's
      // minimum-4 rule, but a mismatched spawn-table length is still
      // handled defensively via Math.min rather than throwing).
      const n = Math.min(spawnSalCodes.length, memberPlayerIds.length);
      for (let i = 0; i < n; i++) {
        upsertOwner.run(lobbyId, spawnSalCodes[i], memberPlayerIds[i]);
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
