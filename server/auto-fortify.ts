// Auto-fortify (ANU-042): a decision layer on top of the existing moveUnits
// dispatch path (ANU-038) that automatically redistributes a player's
// surplus units between their own owned territories, in two modes —
// "balance" (even garrison counts everywhere) and "border" (weight surplus
// toward outward-facing territories, less toward landlocked ones). This
// introduces no new movement primitive: every move it computes is
// dispatched through the same units.moveUnits order a player's own click
// sends, so travel time, reachability rejection (a robot still can't be
// routed somewhere it can't walk to) and in-transit visuals all apply
// unchanged. Per issues/ANU-013.md's file-layout convention: server-side
// logic for this system lives in its own module.
import type { Territory } from "./territory.ts";
import type { AutoFortifyMode } from "./store.ts";
import type { Units } from "./units.ts";
import { adjacentSalCodes } from "./units.ts";

/**
 * A territory counts as "surplus" for a given unit type once it holds more
 * than this many of that type — not specified by the user's request beyond
 * "a threshold," so a value had to be chosen: high enough that a freshly
 * captured or lightly-garrisoned territory is never touched (a handful of
 * units standing somewhere isn't a problem to solve), low enough that a
 * territory producing uncontested for a while (a factory's steady output,
 * server/factories.ts) visibly triggers redistribution within a session
 * rather than requiring dozens of units to pile up first.
 */
export const AUTO_FORTIFY_SURPLUS_THRESHOLD = 6;

/**
 * How much more of a player's garrison a border territory gets, relative to
 * a landlocked one, under "border" mode — not specified by the user's
 * request beyond "receive less," so a ratio had to be chosen: 2:1 is
 * visible without starving every interior territory to zero, the same
 * "a real tradeoff, not cosmetic" spirit as the drone/robot 2x health/damage
 * split (server/units.ts).
 */
const BORDER_WEIGHT = 2;
const LANDLOCKED_WEIGHT = 1;

export interface AutoFortify {
  /**
   * Evaluates and dispatches at most one round of redistribution for this
   * player's current auto-fortify mode — a no-op if their mode is "off", if
   * they own fewer than two territories, or if nothing of theirs is
   * currently over threshold. Call from a ~1s ticker per started lobby per
   * member (same shape as factoryTicker/captureTicker/arrivalTicker,
   * server/index.ts) — this does its own settle-lazily read of current
   * ownership/occupancy each call, so it never needs an armed per-player
   * timer (ADR 0001).
   */
  run(lobbyId: string, playerId: string): void;
}

/**
 * True if every map-adjacent suburb to `salCode` is also owned by
 * `playerId` — confirmed with the user via AskUserQuestion (issues/
 * ANU-042.md's Notes) that ANY non-owned neighbour, enemy or unclaimed,
 * makes a territory "border," so only a territory fully enclosed by the
 * player's own territory is landlocked. A suburb with no map edges at all
 * vacuously counts as landlocked (it borders nothing, friendly or hostile).
 */
function isLandlocked(salCode: string, playerId: string, ownership: Record<string, string>): boolean {
  for (const neighbour of adjacentSalCodes(salCode)) {
    if (ownership[neighbour] !== playerId) return false;
  }
  return true;
}

/**
 * Redistributes one unit type across one player's owned territories for one
 * tick. `groundedCount`/`inTransitTo` are mutated in place as dispatches are
 * computed, so a later source in the same call sees the effect of an
 * earlier one's dispatch rather than double-committing the same units.
 */
function redistributeType(
  units: Units,
  lobbyId: string,
  playerId: string,
  mode: AutoFortifyMode,
  unitTypeKey: string,
  ownedSalCodes: string[],
  groundedCount: Map<string, number>,
  inTransitTo: Map<string, number>,
  landlocked: Map<string, boolean>,
): void {
  // "Effective" garrison = grounded units actually standing there now, plus
  // this player's own units already in transit TOWARD it — counting the
  // latter is what stops this from re-dispatching more units at the same
  // under-count destination every tick before the first batch has even
  // landed (issues/ANU-042.md's "without overcorrecting" requirement).
  const effectiveCount = new Map<string, number>();
  let total = 0;
  for (const salCode of ownedSalCodes) {
    const value = (groundedCount.get(salCode) ?? 0) + (inTransitTo.get(salCode) ?? 0);
    effectiveCount.set(salCode, value);
    total += value;
  }
  if (total === 0) return;

  const weight = (salCode: string): number => {
    if (mode === "balance") return 1;
    return landlocked.get(salCode) ? LANDLOCKED_WEIGHT : BORDER_WEIGHT;
  };
  const totalWeight = ownedSalCodes.reduce((sum, salCode) => sum + weight(salCode), 0);
  const target = (salCode: string): number => (total * weight(salCode)) / totalWeight;

  // Surplus sources: owned territories currently over the threshold,
  // richest first, so the most over-stocked territory is drained before a
  // merely-slightly-over one — deterministic tie-break by sal_code for
  // reproducible tests.
  const sources = ownedSalCodes
    .filter((salCode) => (groundedCount.get(salCode) ?? 0) > AUTO_FORTIFY_SURPLUS_THRESHOLD)
    .sort((a, b) => (groundedCount.get(b) ?? 0) - (groundedCount.get(a) ?? 0) || a.localeCompare(b));

  for (const source of sources) {
    let available = Math.floor(Math.max(0, (groundedCount.get(source) ?? 0) - target(source)));
    if (available <= 0) continue;

    // Under-count destinations, biggest-deficit-relative-to-target first.
    // No reachability pre-check here — units.moveUnits itself rejects an
    // unreachable destination for a robot (its "unreachable" result), so an
    // unreachable candidate is simply skipped and the next one tried,
    // exactly like a player's own order would be if it named a bad target.
    const destinations = ownedSalCodes
      .filter((salCode) => salCode !== source)
      .map((salCode) => ({ salCode, deficit: target(salCode) - (effectiveCount.get(salCode) ?? 0) }))
      .filter((d) => d.deficit > 0)
      .sort((a, b) => b.deficit - a.deficit || a.salCode.localeCompare(b.salCode));

    for (const destination of destinations) {
      if (available <= 0) break;
      const amount = Math.min(available, Math.floor(destination.deficit));
      if (amount <= 0) continue;

      const result = units.moveUnits(lobbyId, playerId, source, destination.salCode, { [unitTypeKey]: amount });
      if (!result.ok) continue; // unreachable (or any other rejection) — try the next candidate, don't move this batch

      available -= amount;
      groundedCount.set(source, (groundedCount.get(source) ?? 0) - amount);
      effectiveCount.set(destination.salCode, (effectiveCount.get(destination.salCode) ?? 0) + amount);
    }
  }
}

export function createAutoFortify(
  territory: Territory,
  units: Units,
  getMode: (lobbyId: string, playerId: string) => AutoFortifyMode,
): AutoFortify {
  return {
    run(lobbyId, playerId) {
      const mode = getMode(lobbyId, playerId);
      if (mode === "off") return;

      const ownership = territory.getOwnership(lobbyId);
      const ownedSalCodes = Object.keys(ownership).filter((salCode) => ownership[salCode] === playerId);
      if (ownedSalCodes.length < 2) return; // nowhere else to send surplus to

      const occupancy = units.getOccupancy(lobbyId).filter((u) => u.ownerPlayerId === playerId);
      const ownedSalCodeSet = new Set(ownedSalCodes);

      // unitTypeKey -> salCode -> count, split into grounded-here (can be
      // dispatched again) vs. already-in-transit-toward (reserved, not
      // dispatchable, but still counted toward that destination's
      // effective garrison — see redistributeType). Archetypes are kept
      // separate throughout: a drone surplus should never trigger moving
      // robots, and vice versa.
      const groundedCountByType = new Map<string, Map<string, number>>();
      const inTransitToByType = new Map<string, Map<string, number>>();

      for (const unit of occupancy) {
        if (unit.destinationSalCode) {
          if (!ownedSalCodeSet.has(unit.destinationSalCode)) continue; // mid-attack on a non-owned suburb — not fortify-relevant
          const bySalCode = inTransitToByType.get(unit.unitTypeKey) ?? new Map<string, number>();
          bySalCode.set(unit.destinationSalCode, (bySalCode.get(unit.destinationSalCode) ?? 0) + 1);
          inTransitToByType.set(unit.unitTypeKey, bySalCode);
        } else {
          const bySalCode = groundedCountByType.get(unit.unitTypeKey) ?? new Map<string, number>();
          bySalCode.set(unit.sal_code, (bySalCode.get(unit.sal_code) ?? 0) + 1);
          groundedCountByType.set(unit.unitTypeKey, bySalCode);
        }
      }

      const landlocked = new Map(ownedSalCodes.map((salCode) => [salCode, isLandlocked(salCode, playerId, ownership)]));

      for (const [unitTypeKey, groundedCount] of groundedCountByType) {
        redistributeType(
          units,
          lobbyId,
          playerId,
          mode,
          unitTypeKey,
          ownedSalCodes,
          groundedCount,
          inTransitToByType.get(unitTypeKey) ?? new Map(),
          landlocked,
        );
      }
    },
  };
}
