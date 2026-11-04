// @ts-check
// Pure view model for the sidebar's suburb-detail panel (ANU-020) — split
// into its own dependency-free file (no DOM access) rather than inlined
// into sidebar.js, same reasoning unit-visual.js/factory-visual.js were
// split out as pure functions: testable directly, without jsdom.
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit */
/** @typedef {import("../protocol.ts").FactoryState} FactoryState */

/**
 * @typedef {object} SuburbDetail
 * @property {string | null} ownerName
 * @property {string | null} ownerColor
 * @property {OccupantUnit[]} occupants
 * @property {FactoryState | null} factory
 * @property {boolean} canBuildFactory
 * @property {OccupantUnit[]} sendableUnits
 */

/**
 * @param {{
 *   sal_code: string,
 *   ownership: Record<string, string>,
 *   occupancy: OccupantUnit[],
 *   factories: FactoryState[],
 *   members: PlayerPresence[],
 *   myPlayerId: string,
 * }} input
 * @returns {SuburbDetail}
 */
export function suburbDetailViewModel({ sal_code, ownership, occupancy, factories, members, myPlayerId }) {
  const memberById = new Map(members.map((m) => [m.playerId, m]));
  const ownerPlayerId = ownership[sal_code] ?? null;
  const owner = ownerPlayerId ? (memberById.get(ownerPlayerId) ?? null) : null;
  const occupants = occupancy.filter((u) => u.sal_code === sal_code);
  const factory = factories.find((f) => f.sal_code === sal_code) ?? null;
  const isOwnedByMe = ownerPlayerId === myPlayerId;

  return {
    ownerName: owner ? owner.name : null,
    ownerColor: owner ? owner.color : null,
    occupants,
    factory,
    canBuildFactory: isOwnedByMe && !factory,
    // Any suburb is a valid "send unit here" target — attackSuburb's
    // reachability rule (server/units.ts) is authoritative; the client just
    // offers the player's own units and lets the server accept/reject.
    sendableUnits: occupancy.filter((u) => u.ownerPlayerId === myPlayerId),
  };
}
