// @ts-check
// Pure view model for the sidebar's suburb-detail panel (ANU-020) — split
// into its own dependency-free file (no DOM access) rather than inlined
// into sidebar.js, same reasoning unit-visual.js/factory-visual.js were
// split out as pure functions: testable directly, without jsdom.
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit */
/** @typedef {import("../protocol.ts").FactoryState} FactoryState */

/**
 * One of the viewing player's own unit types present at the selected
 * suburb, and how many — the Risk-style "Move units" quantity panel's
 * per-row data (ANU-027), replacing the old one-unit-at-a-time
 * `sendableUnits` list.
 * @typedef {object} MovableUnitGroup
 * @property {string} unitTypeKey
 * @property {number} count
 */

/**
 * One (owner, unit type) cluster among a suburb's occupants, for the
 * Territory detail panel's occupant list — grouped the same way a large
 * stack of units reads on the map (ANU-034's per-archetype marker counts),
 * rather than one row per individual unit, which became an unreadable wall
 * of identical "Drone — Beno (3 hp)" rows once a player had more than a
 * handful of units at one suburb.
 * @typedef {object} OccupantGroup
 * @property {string} ownerPlayerId
 * @property {string} unitTypeKey
 * @property {number} count
 */

/**
 * @typedef {object} SuburbDetail
 * @property {string | null} ownerName
 * @property {string | null} ownerColor
 * @property {OccupantUnit[]} occupants
 * @property {OccupantGroup[]} occupantGroups
 * @property {FactoryState | null} factory
 * @property {boolean} canBuildFactory
 * @property {MovableUnitGroup[]} movableUnitGroups
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

  const countByType = new Map();
  for (const unit of occupants) {
    if (unit.ownerPlayerId !== myPlayerId) continue;
    countByType.set(unit.unitTypeKey, (countByType.get(unit.unitTypeKey) ?? 0) + 1);
  }

  /** @type {Map<string, OccupantGroup>} */
  const occupantGroupByKey = new Map();
  for (const unit of occupants) {
    const key = `${unit.ownerPlayerId}|${unit.unitTypeKey}`;
    const existing = occupantGroupByKey.get(key);
    if (existing) existing.count += 1;
    else occupantGroupByKey.set(key, { ownerPlayerId: unit.ownerPlayerId, unitTypeKey: unit.unitTypeKey, count: 1 });
  }

  return {
    ownerName: owner ? owner.name : null,
    ownerColor: owner ? owner.color : null,
    occupants,
    occupantGroups: [...occupantGroupByKey.values()],
    factory,
    canBuildFactory: isOwnedByMe && !factory,
    // Grouped by type, counted at THIS suburb only — moveUnits' reachability
    // rule (server/units.ts) is per destination and is authoritative; the
    // client just offers how many of each type the player could send from
    // here and lets the server accept/reject the actual order.
    movableUnitGroups: [...countByType.entries()].map(([unitTypeKey, count]) => ({ unitTypeKey, count })),
  };
}
