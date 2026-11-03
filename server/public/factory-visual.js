// @ts-check
// Map-drawable, not yet player-controllable (ANU-013/ANU-015's GUI boundary
// — see issues/ANU-013.md Notes): a pure function from factory state to a
// drawable shape. No control here triggers an action; that stays
// protocol-only until all four ANU-013-downstream systems land. Plain JS
// (browsers can't run TypeScript, no bundler) typed against
// server/protocol.ts via JSDoc, same pattern as unit-visual.js.
/** @typedef {import("../protocol.ts").FactoryState} FactoryState */

/**
 * @typedef {object} FactoryVisual
 * @property {"factory"} icon - one shape for every factory; ownership is
 *   conveyed by ownerColor, not a second icon (color is reserved for
 *   ownership per issues/ANU-013.md, same convention unit-visual.js follows).
 * @property {string} ownerColor
 * @property {number | null} queueProgressFraction - 0 (just queued) to 1
 *   (about to complete); null while idle, so callers can distinguish
 *   "no progress yet" from "nothing queued" rather than both rendering as 0.
 */

/**
 * @param {FactoryState} factory
 * @param {string} ownerColor - the factory owner's lobby color (ANU-013's
 *   PLAYER_COLORS), looked up by the caller from LobbyState.members since
 *   FactoryState itself only carries ownerPlayerId, not a color.
 * @returns {FactoryVisual}
 */
export function factoryVisual(factory, ownerColor) {
  return {
    icon: "factory",
    ownerColor,
    queueProgressFraction: factory.queueProgressFraction,
  };
}
