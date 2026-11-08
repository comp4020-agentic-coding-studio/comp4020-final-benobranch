// Suburb ownership (ANU-013 schema/kickoff-assignment) and the ANU-017
// capture state machine (contested progress, pause/resume/reset) that reads/
// writes the same table's capture-state columns. Per issues/ANU-013.md's
// file-layout convention: server-side logic for this system lives in its
// own module.
import type { DatabaseSync } from "node:sqlite";
import { spawnSalCodesForCapacity } from "./map-data.ts";
import { createPerkHook } from "./perks.ts";
import { backdatedStart, elapsedMs, GAME_TIME_SCALE, nowIso } from "./time.ts";
import type { SuburbCaptureState } from "./protocol.ts";

/**
 * Design duration (game-ms, scaled by GAME_TIME_SCALE/captureSpeedMultiplier
 * like every other timed value — server/time.ts) for an uncontested capture
 * to complete. Not specified by the user's request beyond "progress on
 * capture" and a ~1s broadcast cadence, so a value had to be chosen: longer
 * than a single unit build (drone 1500ms/robot 3000ms design durations,
 * server/units.ts) since taking a zone is a bigger strategic commitment than
 * producing one unit, short enough that a real-time siege still feels
 * responsive within a session.
 */
export const CAPTURE_DURATION_MS = 60_000;

/**
 * How long an EMP's blackout (server/units.ts's settleArrivals — an "emp"
 * unit's arrival always detonates, never fights) disables a territory's
 * factory production (server/factories.ts) and data-center TFLOPS
 * contribution (server/tflops.ts) for, per the user's own instruction
 * ("Set that duration for 20 minutes for the moment"). Capture progress and
 * combat at a blacked-out suburb are explicitly NOT affected (confirmed with
 * the user via AskUserQuestion — issues/ANU-048.md's Notes) — this constant
 * only gates `isEmpActive` below, which `settleFactory`/`getTflops` check,
 * not `settleSuburb`.
 */
export const EMP_BLACKOUT_DURATION_MS = 20 * 60_000;

export interface CaptureTransfer {
  salCode: string;
  newOwnerPlayerId: string;
}

interface CaptureRow {
  ownerPlayerId: string | null;
  capturingPlayerId: string | null;
  captureStartedAt: string | null;
  captureAccumulatedMs: number;
}

const DEFAULT_CAPTURE_ROW: CaptureRow = {
  ownerPlayerId: null,
  capturingPlayerId: null,
  captureStartedAt: null,
  captureAccumulatedMs: 0,
};

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
  /**
   * Runs the capture state machine's pause/resume/reset/complete
   * transitions against current occupancy (server/units.ts) for every
   * suburb with activity (occupants present, or an existing in-progress
   * capture whose occupants have since left) in this lobby, writing updated
   * `suburb_ownership` rows directly — a single synchronous pass per call,
   * no `await` between reading occupancy and writing the resulting state
   * (ADR 0001/ANU-008/ANU-015's concurrency reasoning). Returns the current
   * capture state for broadcast plus every suburb whose ownership
   * transferred THIS call, so index.ts can relay completions to
   * server/factories.ts's `transferFactoryOwnership` and re-broadcast lobby
   * state (ownership). Call before every occupancy-driven broadcast
   * (placeUnit/moveUnit/attackSuburb) and from a ~1s ticker — never from an
   * armed per-suburb timer.
   */
  settleCaptures(lobbyId: string): { captures: SuburbCaptureState[]; transfers: CaptureTransfer[] };
  /**
   * Starts (or refreshes) an EMP blackout at `salCode`, regardless of
   * current ownership (an EMP can land on a neutral/unowned suburb — "any
   * territory" per the user's request) — called by server/units.ts's
   * settleArrivals the instant an "emp" unit's arrival detonates. A second
   * strike on an already-active blackout REFRESHES the full duration from
   * this moment rather than stacking or being rejected (confirmed with the
   * user via AskUserQuestion — issues/ANU-048.md's Notes), which this
   * implements trivially by always overwriting `emp_started_at` to now.
   */
  empStrike(lobbyId: string, salCode: string): void;
  /** Whether `salCode` currently has an unexpired EMP blackout — checked by server/factories.ts's settleFactory and server/tflops.ts's getTflops before advancing production / counting TFLOPS. */
  isEmpActive(lobbyId: string, salCode: string): boolean;
  /**
   * sal_code -> ISO expiry timestamp (emp_started_at + EMP_BLACKOUT_DURATION_MS
   * in real time) for every suburb with an active blackout in this lobby —
   * sparse, same convention as `getOwnership`/`settleCaptures`'s `captures`.
   * Broadcast on `LobbyState.empActiveUntil` so clients can derive a live
   * countdown without polling (server/protocol.ts).
   */
  getActiveEmpBlackouts(lobbyId: string): Record<string, string>;
}

export function createTerritory(db: DatabaseSync): Territory {
  const perks = createPerkHook(db);

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
  const selectCaptureRow = db.prepare(`
    SELECT owner_player_id AS ownerPlayerId, capturing_player_id AS capturingPlayerId,
           capture_started_at AS captureStartedAt, capture_accumulated_ms AS captureAccumulatedMs
    FROM suburb_ownership WHERE lobby_id = ? AND sal_code = ?
  `);
  const upsertCaptureRow = db.prepare(`
    INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id, capturing_player_id, capture_started_at, capture_accumulated_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(lobby_id, sal_code) DO UPDATE SET
      owner_player_id = excluded.owner_player_id,
      capturing_player_id = excluded.capturing_player_id,
      capture_started_at = excluded.capture_started_at,
      capture_accumulated_ms = excluded.capture_accumulated_ms
  `);
  // Suburbs with units currently present, grouped by occupying player, with
  // the earliest spawned_at per player at that suburb — the only ordering
  // signal available (units.ts has no "entered this suburb at" timestamp,
  // only unit-creation time), used purely as a deterministic tie-break for
  // the rare case where nobody was already capturing and multiple players'
  // units are present in the same settle() call (see settleSuburb).
  const selectOccupancyGroups = db.prepare(`
    SELECT sal_code AS salCode, owner_player_id AS ownerPlayerId, MIN(spawned_at) AS earliestSpawnedAt
    FROM units WHERE lobby_id = ?
    GROUP BY sal_code, owner_player_id
    ORDER BY sal_code, earliestSpawnedAt, owner_player_id
  `);
  // Catches a suburb whose capturer has fully retreated (no occupants left
  // at all) — still needs a settle pass to freeze its progress, even though
  // the occupancy query above returns no row for it.
  const selectActiveCaptureSalCodes = db.prepare(
    "SELECT sal_code AS salCode FROM suburb_ownership WHERE lobby_id = ? AND capturing_player_id IS NOT NULL",
  );
  // EMP blackout (ANU-048): an INSERT ... ON CONFLICT upsert, same shape as
  // upsertOwner above, so a strike on a suburb with no suburb_ownership row
  // yet (neutral/unowned — an EMP can land anywhere) still records the
  // blackout rather than requiring ownership to exist first. Always
  // OVERWRITES emp_started_at to now, which is exactly the confirmed
  // "refresh to full duration, don't stack" re-strike rule — there is no
  // separate "already active" branch to write.
  const upsertEmpStrike = db.prepare(`
    INSERT INTO suburb_ownership (lobby_id, sal_code, emp_started_at)
    VALUES (?, ?, ?)
    ON CONFLICT(lobby_id, sal_code) DO UPDATE SET emp_started_at = excluded.emp_started_at
  `);
  const selectEmpStartedAt = db.prepare(
    "SELECT emp_started_at AS empStartedAt FROM suburb_ownership WHERE lobby_id = ? AND sal_code = ?",
  );
  const selectActiveEmpBlackouts = db.prepare(
    "SELECT sal_code AS salCode, emp_started_at AS empStartedAt FROM suburb_ownership WHERE lobby_id = ? AND emp_started_at IS NOT NULL",
  );

  function effectiveCaptureDurationMs(lobbyId: string, capturingPlayerId: string): number {
    const speedMultiplier = perks.getPerkMultipliers(lobbyId, capturingPlayerId).captureSpeedMultiplier;
    const safeSpeedMultiplier = speedMultiplier > 0 ? speedMultiplier : 1; // defend against a malformed perk value dividing by zero
    return CAPTURE_DURATION_MS / safeSpeedMultiplier;
  }

  /**
   * One suburb's transition, covering every case issues/ANU-017.md names:
   * no capturer present (freeze if one was running), exactly one capturer
   * (accrue/resume, or reset-and-restart if a different player displaced
   * the previous capturer), two-or-more capturers (contested — freeze,
   * keeping whichever of them is already the recorded capturer as the
   * "resident" being invaded rather than picking a new one every tick).
   */
  function settleSuburb(
    lobbyId: string,
    salCode: string,
    occupantOwners: { ownerPlayerId: string; earliestSpawnedAt: string }[],
  ): CaptureTransfer | null {
    const row = (selectCaptureRow.get(lobbyId, salCode) as CaptureRow | undefined) ?? DEFAULT_CAPTURE_ROW;
    // The suburb's own registered owner's units are defenders, not
    // capturers — "a competing player" (issues/ANU-017.md) means another
    // player ALSO vying to take the zone, not the passive incumbent. This
    // is also what makes case 4 of the visual spec work (an owner's fill
    // stays while just the invader's stripe pulses): the owner isn't
    // "contesting" their own zone.
    const capturers = occupantOwners.filter((o) => o.ownerPlayerId !== row.ownerPlayerId);

    let ownerPlayerId = row.ownerPlayerId;
    let capturingPlayerId = row.capturingPlayerId;
    let captureStartedAt = row.captureStartedAt;
    let captureAccumulatedMs = row.captureAccumulatedMs;
    let transfer: CaptureTransfer | null = null;

    if (capturers.length === 0) {
      // Nobody (other than the owner) is here. If a capture was running,
      // pause it — leaving with no contester is treated the same as being
      // contested-and-paused, not a reset: reset is reserved for a
      // contester actively displacing the original capturer (handled
      // below), not mere absence.
      if (capturingPlayerId !== null && captureStartedAt !== null) {
        captureAccumulatedMs = elapsedMs(captureStartedAt);
        captureStartedAt = null;
      }
    } else if (capturers.length === 1) {
      const sole = capturers[0].ownerPlayerId;
      if (capturingPlayerId === sole) {
        // Resume without loss if this was paused — "a new capture_started_at
        // set to 'now minus accumulated,' not a progress reset" (issues/ANU-017.md).
        if (captureStartedAt === null) captureStartedAt = backdatedStart(captureAccumulatedMs);
      } else {
        // Either nobody was capturing yet, or `sole` has displaced whoever
        // was (the contester's own units took the zone) — the original
        // capturer's progress resets to zero and `sole` starts fresh.
        capturingPlayerId = sole;
        captureAccumulatedMs = 0;
        captureStartedAt = nowIso();
      }
      const totalMs = elapsedMs(captureStartedAt);
      const durationMs = effectiveCaptureDurationMs(lobbyId, capturingPlayerId);
      if (totalMs >= durationMs) {
        ownerPlayerId = capturingPlayerId;
        transfer = { salCode, newOwnerPlayerId: capturingPlayerId };
        capturingPlayerId = null;
        captureStartedAt = null;
        captureAccumulatedMs = 0;
      }
    } else {
      // Contested by 2+ players. Keep whichever of them is already the
      // recorded capturer as the "resident" (so a third/fourth arrival
      // doesn't reassign who's being invaded); only pick a new resident
      // (deterministically, by earliest-present) if nobody was capturing
      // yet or the recorded capturer isn't among the current occupants.
      const residentStillPresent = capturers.some((c) => c.ownerPlayerId === capturingPlayerId);
      if (!residentStillPresent) {
        capturingPlayerId = capturers[0].ownerPlayerId;
        captureAccumulatedMs = 0;
        captureStartedAt = null;
      } else if (captureStartedAt !== null) {
        captureAccumulatedMs = elapsedMs(captureStartedAt);
        captureStartedAt = null;
      }
    }

    upsertCaptureRow.run(lobbyId, salCode, ownerPlayerId, capturingPlayerId, captureStartedAt, captureAccumulatedMs);
    return transfer;
  }

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

    settleCaptures(lobbyId) {
      const occupancyRows = selectOccupancyGroups.all(lobbyId) as {
        salCode: string;
        ownerPlayerId: string;
        earliestSpawnedAt: string;
      }[];
      const occupantsBySalCode = new Map<string, { ownerPlayerId: string; earliestSpawnedAt: string }[]>();
      for (const r of occupancyRows) {
        if (!occupantsBySalCode.has(r.salCode)) occupantsBySalCode.set(r.salCode, []);
        occupantsBySalCode.get(r.salCode)!.push({ ownerPlayerId: r.ownerPlayerId, earliestSpawnedAt: r.earliestSpawnedAt });
      }

      const activeCaptureSalCodes = (selectActiveCaptureSalCodes.all(lobbyId) as { salCode: string }[]).map((r) => r.salCode);
      const workingSalCodes = new Set([...occupantsBySalCode.keys(), ...activeCaptureSalCodes]);

      const transfers: CaptureTransfer[] = [];
      for (const salCode of workingSalCodes) {
        const transfer = settleSuburb(lobbyId, salCode, occupantsBySalCode.get(salCode) ?? []);
        if (transfer) transfers.push(transfer);
      }

      const captures: SuburbCaptureState[] = [];
      for (const salCode of workingSalCodes) {
        const row = selectCaptureRow.get(lobbyId, salCode) as CaptureRow | undefined;
        if (!row || row.capturingPlayerId === null) continue; // sparse — no capture in progress here
        const occupants = occupantsBySalCode.get(salCode) ?? [];
        const contestingPlayerIds = occupants
          .map((o) => o.ownerPlayerId)
          .filter((id) => id !== row.ownerPlayerId && id !== row.capturingPlayerId);
        const totalMs = row.captureStartedAt !== null ? elapsedMs(row.captureStartedAt) : row.captureAccumulatedMs;
        const durationMs = effectiveCaptureDurationMs(lobbyId, row.capturingPlayerId);
        captures.push({
          sal_code: salCode,
          capturingPlayerId: row.capturingPlayerId,
          contestingPlayerIds,
          progressFraction: Math.max(0, Math.min(1, totalMs / durationMs)),
        });
      }

      return { captures, transfers };
    },

    empStrike(lobbyId, salCode) {
      upsertEmpStrike.run(lobbyId, salCode, nowIso());
    },

    isEmpActive(lobbyId, salCode) {
      const row = selectEmpStartedAt.get(lobbyId, salCode) as { empStartedAt: string | null } | undefined;
      if (!row?.empStartedAt) return false;
      return elapsedMs(row.empStartedAt) < EMP_BLACKOUT_DURATION_MS;
    },

    getActiveEmpBlackouts(lobbyId) {
      const rows = selectActiveEmpBlackouts.all(lobbyId) as { salCode: string; empStartedAt: string }[];
      const result: Record<string, string> = {};
      for (const row of rows) {
        if (elapsedMs(row.empStartedAt) >= EMP_BLACKOUT_DURATION_MS) continue; // expired — not active, don't report it
        // emp_started_at + EMP_BLACKOUT_DURATION_MS converted to real ms the
        // same way backdatedStart converts an accumulated GAME-ms duration —
        // the client derives its own live countdown from this absolute
        // timestamp (same "server sends a timestamp, client computes the
        // live value" split every other progress readout in this codebase
        // already uses), so it must be a real wall-clock instant, not a
        // GAME_TIME_SCALE-scaled one.
        const realDurationMs = GAME_TIME_SCALE > 0 ? EMP_BLACKOUT_DURATION_MS / GAME_TIME_SCALE : 0;
        const expiresAt = new Date(Date.parse(row.empStartedAt) + realDurationMs).toISOString();
        result[row.salCode] = expiresAt;
      }
      return result;
    },
  };
}
