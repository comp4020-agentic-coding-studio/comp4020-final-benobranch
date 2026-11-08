// Live TFLOPS (ANU-019, superseding ANU-013's stubbed balance column and
// ANU-016's spend-based reading of it). PLAN.md: a data center's TFLOPS
// rating is a speed multiplier on skill-tree research, not a currency — so
// "a player's TFLOPS" is just the sum of the data centers they currently
// hold, recomputed from suburb_ownership at read time. No stored balance,
// no accrual-over-time, no stored-timestamp (ADR 0001's rule doesn't apply
// here: there's nothing to settle lazily, since this is a snapshot of
// current state, not a duration). Per issues/ANU-013.md's file-layout
// convention: server-side logic for this system lives in its own module.
import { getDataCenterTflopsBySalCode } from "./map-data.ts";
import type { Territory } from "./territory.ts";

export interface TflopsSource {
  /** Sum of the TFLOPS of every data-center suburb `playerId` currently owns in `lobbyId`. 0 if they hold none. */
  getTflops(lobbyId: string, playerId: string): number;
}

export function createTflopsSource(territory: Territory): TflopsSource {
  const dataCenterTflops = getDataCenterTflopsBySalCode();

  return {
    getTflops(lobbyId, playerId) {
      const ownership = territory.getOwnership(lobbyId);
      let total = 0;
      for (const [salCode, ownerPlayerId] of Object.entries(ownership)) {
        if (ownerPlayerId !== playerId) continue;
        // ANU-048: a data-center suburb under an active EMP blackout
        // contributes 0 TFLOPS for the duration — no persisted balance to
        // unfreeze here (TFLOPS is already a live-computed sum, not an
        // accrued one, per this module's own header comment), so this is
        // just a filter on the existing per-suburb loop, not a settle/
        // resume mechanism the way server/factories.ts's production needs.
        if (territory.isEmpActive(lobbyId, salCode)) continue;
        total += dataCenterTflops.get(salCode) ?? 0;
      }
      return total;
    },
  };
}
