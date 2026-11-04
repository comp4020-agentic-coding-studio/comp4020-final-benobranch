// Shared "stored timestamp, not a running timer" helper — see ADR 0001 and
// issues/ANU-013.md: every duration (capture time, production time, unit
// travel, TFLOPS/scrap accrual) must be computed from a stored start time +
// elapsed wall-clock time at read/broadcast time, because fly.toml's
// auto_stop_machines means nothing keeps running while the machine is idle.
// GAME_TIME_SCALE lets spec/ exercise a multi-minute design duration in real
// seconds, by multiplying every elapsed-time calculation that goes through
// `elapsedMs` below.
export const GAME_TIME_SCALE = Number(process.env.GAME_TIME_SCALE ?? "1");

/**
 * Elapsed time since an ISO timestamp, scaled by GAME_TIME_SCALE (or an
 * explicit override, for code that reads the scale once and passes it down).
 * Returns 0 for a null/undefined start (nothing has started yet).
 */
export function elapsedMs(startedAt: string | null | undefined, scale: number = GAME_TIME_SCALE): number {
  if (!startedAt) return 0;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  const realElapsed = Date.now() - started;
  return Math.max(0, realElapsed) * scale;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The inverse of elapsedMs: a timestamp such that elapsedMs(result, scale)
 * read back immediately equals `accumulatedMs` — used to resume a paused
 * stored-timestamp duration (ANU-017's capture pause/resume) without losing
 * progress: "a new capture_started_at set to 'now minus accumulated,' not a
 * progress reset" (issues/ANU-017.md).
 */
export function backdatedStart(accumulatedMs: number, scale: number = GAME_TIME_SCALE): string {
  const realOffsetMs = scale > 0 ? accumulatedMs / scale : 0;
  return new Date(Date.now() - realOffsetMs).toISOString();
}
