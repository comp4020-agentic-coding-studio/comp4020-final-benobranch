// @ts-check
// Map-drawable, not yet player-controllable (ANU-017's visual function, same
// "pure function from server state to a drawable shape" convention as
// unit-visual.js/factory-visual.js): maps a suburb's ownership + in-progress
// capture state to the diagonal-stripe contest visual the user described.
// Checkable entirely from spec/ (CLAUDE.md's current no-manual-e2e rule) —
// no DOM access here, just data in, shape out. Plain JS (browsers can't run
// TypeScript, no bundler) typed against server/protocol.ts via JSDoc.
/** @typedef {import("../protocol.ts").SuburbCaptureState} SuburbCaptureState */

/**
 * @typedef {object} ZoneStripe
 * @property {string} color
 * @property {boolean} pulsing
 */

/**
 * @typedef {object} ZoneVisual
 * @property {{ color: string, opacity: number } | null} fill - the owner's
 *   semi-opaque territory fill, or null for a neutral (unowned) suburb.
 * @property {ZoneStripe[]} stripes - 0, 1 or (confirmed with the user: a
 *   suburb can be contested by more than one opposing player at once, since
 *   lobbies go up to 12) more entries, each a non-overlapping diagonal-stripe
 *   layer (distinct angle/offset per index — see renderCapture in map.js).
 * @property {number | null} progress - 0 (just started) to 1 (about to
 *   transfer), rendered at the suburb's center; null if no capture is
 *   in progress.
 */

/** Semi-opaque fill — same 0.45 opacity map.js's existing ANU-020 ownership fill uses, so a captured-FROM owner's territory doesn't visually change tone the moment a capture starts. */
const OWNER_FILL_OPACITY = 0.45;

/**
 * @param {{
 *   ownerPlayerId: string | null,
 *   capture: Omit<SuburbCaptureState, "sal_code"> | null,
 *   colorByPlayerId: Map<string, string>,
 * }} input - `capture` is the sparse ServerCaptures entry for this suburb
 *   (null if no capture is in progress here); `ownerPlayerId` is this
 *   suburb's current entry (if any) in LobbyState.ownership.
 * @returns {ZoneVisual}
 */
export function zoneVisual({ ownerPlayerId, capture, colorByPlayerId }) {
  const ownerColor = ownerPlayerId ? (colorByPlayerId.get(ownerPlayerId) ?? null) : null;
  const fill = ownerColor ? { color: ownerColor, opacity: OWNER_FILL_OPACITY } : null;

  if (!capture) {
    // Case 1: owned (or neutral), no capture in progress — plain fill, no stripes.
    return { fill, progress: null, stripes: [] };
  }

  const capturerColor = colorByPlayerId.get(capture.capturingPlayerId) ?? "#888";
  const contesterColors = capture.contestingPlayerIds.map((id) => colorByPlayerId.get(id) ?? "#888");

  if (ownerPlayerId !== null) {
    // Case 4: a player owns the zone and another player (or players — the
    // user's own phrasing, "invading players," is already plural) is
    // invading it — the owner's fill stays (confirmed with the user: it
    // doesn't go null or switch to the invader's color mid-capture), and
    // ONLY the invading players' stripes show, all pulsing, overlaid on
    // that fill. The owner never gets a stripe of their own here
    // (issues/ANU-017.md: "the owner does not also get a stripe in this
    // case") — every occupant here besides the owner is an invader, so the
    // capturer/contester distinction that matters for an unowned zone
    // (case 3) doesn't apply: nobody is "the resident" except the absent
    // owner.
    return {
      fill,
      progress: capture.progressFraction,
      stripes: [capturerColor, ...contesterColors].map((color) => ({ color, pulsing: true })),
    };
  }

  if (contesterColors.length === 0) {
    // Case 2: neutral zone, one player capturing, uncontested — the
    // capturer's stripe doesn't pulse (nothing is being attacked yet, just
    // claimed outright).
    return { fill: null, progress: capture.progressFraction, stripes: [{ color: capturerColor, pulsing: false }] };
  }

  // Case 3: neutral zone, two-or-more players present — the original
  // capturer's stripe stays still, every contester's stripe pulses ("pulse
  // to show who is attacking who" — the invader(s) specifically).
  return {
    fill: null,
    progress: capture.progressFraction,
    stripes: [
      { color: capturerColor, pulsing: false },
      ...contesterColors.map((color) => ({ color, pulsing: true })),
    ],
  };
}
