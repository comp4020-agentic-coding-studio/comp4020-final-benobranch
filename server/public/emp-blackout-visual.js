// @ts-check
// Map-drawable, pure function (ANU-048) — same "testable without jsdom"
// convention as capture-visual.js's zoneVisual: no DOM/geometry access, just
// data in, drawable shape out. map.js resolves this into actual SVG
// elements the same way it already does for zoneVisual's stripes/progress.
// A new file, not added to capture-visual.js, since an EMP blackout isn't a
// capture-state concept (it never pulses, has no owner-vs-invader
// distinction, and is driven by a flat expiry timestamp rather than a
// progress fraction) — per issues/ANU-013.md's one-system-one-file
// convention.

/**
 * @typedef {object} EmpBlackoutVisual
 * @property {boolean} active
 * @property {string | null} countdownLabel - "MM:SS" remaining, or null when not active.
 */

/**
 * @param {{ empActiveUntil: string | undefined, now: number }} input -
 *   `empActiveUntil` is this suburb's sparse LobbyState.empActiveUntil entry
 *   (absent/undefined when no blackout is active here); `now` is an epoch-ms
 *   timestamp the caller supplies (map.js's own Date.now()) rather than this
 *   function reading the clock itself, so it stays a pure function of its
 *   inputs and is exactly reproducible in a test.
 * @returns {EmpBlackoutVisual}
 */
export function empBlackoutVisual({ empActiveUntil, now }) {
  if (!empActiveUntil) return { active: false, countdownLabel: null };
  const remainingMs = Date.parse(empActiveUntil) - now;
  if (!(remainingMs > 0)) return { active: false, countdownLabel: null }; // expired (or an unparseable timestamp) reads as inactive, same as absent
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const countdownLabel = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return { active: true, countdownLabel };
}
