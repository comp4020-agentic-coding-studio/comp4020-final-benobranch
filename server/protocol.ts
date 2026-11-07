// Wire shapes shared between the server and any client. Kept in one module
// so later subsystems (map/combat, UI) build against a single source of
// truth instead of each guessing the WebSocket message shape independently.
//
// This still isn't game rules — it's the multi-lobby, persistent-identity
// skeleton ANU-009's Home/Browse/HUD screens render against. ANU-005's
// original throwaway shared-counter stand-in (`bump`/`count`/`lastBumpedBy`)
// was retired by ANU-011 once a started lobby had something real (the map)
// to show instead.

export interface ClientHello {
  type: "hello";
  /**
   * Secret token from a previous `welcome`, stored client-side, to resume
   * the same playerId (and, if they have one, their current lobby) rather
   * than being treated as a brand-new player. Absent (or no longer valid)
   * on a first-ever visit.
   */
  token?: string;
}

export interface ClientCreateLobby {
  type: "createLobby";
  /** The lobby's own name (shown in Server Browse), not the player's. */
  name: string;
  capacity: number;
  /**
   * The player's callsign *in this lobby* — set once, at creation, and
   * locked for as long as they're a member (see ADR 0002): the device
   * token identifies the player across the whole app, but this name is
   * their persona within this one game.
   */
  callsign: string;
}

export interface ClientJoinLobby {
  type: "joinLobby";
  lobbyId: string;
  /**
   * Required only the first time this player joins this lobby — locked
   * after that, same as `createLobby`'s. Omit (or send anything) on a
   * later reconnect to an already-joined lobby; the server ignores it.
   */
  callsign?: string;
}

export interface ClientStartLobby {
  /**
   * Starts the sender's current lobby (no lobbyId — always "my lobby").
   * Minimal, hand-triggered stand-in for PLAN.md's real Sunday 5pm
   * scheduled kickoff + bot-fill, which are out of scope here (see
   * issues/ANU-009.md) — this just gives the UI a real "started" state to
   * represent and enforce "no late join" against.
   */
  type: "startLobby";
}

export interface ClientWatchLobbies {
  type: "watchLobbies";
}

export interface ClientUnwatchLobbies {
  type: "unwatchLobbies";
}

export interface ClientPlaceUnit {
  /**
   * Minimal occupancy primitive (ANU-013) — places a new unit in a suburb.
   * Eligibility is deliberately "any suburb" here; ANU-014 replaces this
   * placeholder check with real adjacency/flight rules without changing
   * this message's shape.
   */
  type: "placeUnit";
  sal_code: string;
  unitTypeKey: string;
}

export interface ClientMoveUnits {
  /**
   * Risk-style bulk move/attack order (ANU-027), replacing the old
   * one-unit-at-a-time `moveUnit`/`attackSuburb` messages: pick a source
   * suburb the player has units in, declare how many of each unit type to
   * send, then a destination. `counts` is keyed by `unit_types.key` (e.g.
   * `{ drone: 5, robot: 2 }`) — a type with no entry (or a zero/negative
   * count) sends none of that type. Uses the same movement-mode
   * reachability rule `moveUnit`/`attackSuburb` always did (unrestricted
   * for drones, road-adjacent-to-owned for robots — server/units.ts), now
   * enforced per type across the whole order: if any requested type can't
   * reach `toSalCode`, or more of a type is requested than currently sit
   * at `fromSalCode`, the WHOLE order is rejected, not partially applied.
   * If the destination holds no enemy units ("undefended"), each sent unit
   * just moves there; otherwise each one resolves combat in turn against
   * whichever defender remains, same per-unit combat rule as before.
   */
  type: "moveUnits";
  fromSalCode: string;
  toSalCode: string;
  counts: Record<string, number>;
}

export interface ClientBuildFactory {
  /**
   * Builds an additional factory (ANU-015) in a suburb the sender already
   * owns — the first factory per player is placed automatically at kickoff
   * (server/factories.ts's spawnFactories); this is for every one after
   * that. Costs a flat scrap amount (server/factories.ts's
   * FACTORY_BUILD_COST_SCRAP, scaled by the factoryBuildCostMultiplier perk
   * hook as of ANU-022 — see that issue's Resolution for why: scrap no
   * longer funds individual units, only new factories, so that's the node
   * this multiplier now cheapens), no adjacency-to-an-existing-factory
   * restriction (confirmed with the user via AskUserQuestion — see
   * issues/ANU-015.md's Resolution).
   */
  type: "buildFactory";
  sal_code: string;
}

export interface ClientStartResearch {
  /**
   * Starts researching a skill-tree node (ANU-016, time-gated by ANU-019):
   * the node unlocks on its own once its base research time (divided by the
   * sender's current live-TFLOPS speed multiplier — held data centers speed
   * this up, they're never spent on it; see PLAN.md's "Data centers"
   * section) has elapsed, settled lazily like every other stored-timestamp
   * duration (server/time.ts's elapsedMs). Rejected if the node's
   * prerequisite (if any) isn't already unlocked, if it's already unlocked,
   * or if the sender already has a different (or the same) node in
   * progress — one active research slot per player, not a queue — see
   * server/skill-tree.ts.
   */
  type: "startResearch";
  nodeId: string;
}

/** ANU-042: every valid value of AutoFortifyMode — the single source parseClientMessage validates against. */
export const AUTO_FORTIFY_MODES = ["off", "balance", "border"] as const;
export type AutoFortifyMode = (typeof AUTO_FORTIFY_MODES)[number];

export interface ClientSetAutoFortifyMode {
  /**
   * Sets the sender's auto-fortify preference for their current lobby
   * (ANU-042): "off" (default — no automatic redistribution), "balance"
   * (even out garrison counts across every owned territory) or "border"
   * (weight surplus toward territories bordering an enemy or unclaimed
   * suburb, over interior ones). Takes effect on the next ~1s auto-fortify
   * sweep (server/index.ts); doesn't affect units already in transit.
   */
  type: "setAutoFortifyMode";
  mode: AutoFortifyMode;
}

export type ClientMessage =
  | ClientHello
  | ClientCreateLobby
  | ClientJoinLobby
  | ClientStartLobby
  | ClientWatchLobbies
  | ClientUnwatchLobbies
  | ClientPlaceUnit
  | ClientMoveUnits
  | ClientBuildFactory
  | ClientStartResearch
  | ClientSetAutoFortifyMode;

export interface PlayerPresence {
  playerId: string;
  name: string;
  online: boolean;
  /** Assigned once at join (see ADR 0002's "locked in" precedent for callsign), unique per lobby. */
  color: string;
  /**
   * The suburb this player was assigned at kickoff (territory.ts's
   * assignSpawnOwnership) — null before the lobby has started. Distinct
   * from current ownership: a player's base marker (ANU-025) renders here
   * only while `ownership[spawnSalCode] === playerId` still holds, so it
   * disappears the moment this suburb is captured rather than following
   * the player to wherever they currently hold territory.
   */
  spawnSalCode: string | null;
}

export interface LobbyState {
  lobbyId: string;
  name: string;
  capacity: number;
  started: boolean;
  /** Stored-timestamp rule (ANU-013/ADR 0001): null until startLobby fires. */
  startedAt: string | null;
  /** Elapsed real time since startedAt, scaled by GAME_TIME_SCALE — derived at broadcast time, never from a running timer. */
  gameElapsedMs: number;
  members: PlayerPresence[];
  /** sal_code -> owner playerId, sparse (unowned suburbs are simply absent). */
  ownership: Record<string, string>;
}

export interface OccupantUnit {
  id: string;
  ownerPlayerId: string;
  /**
   * Where this unit currently stands — while in transit (destinationSalCode
   * set), this is still the ORIGIN it departed from, not an interpolated
   * position; the client derives the visual position along the
   * origin-to-destination line itself from moveStartedAt/the unit type's
   * travel time (ANU-038), same "server sends a stored timestamp, client
   * derives the animated value" split capture progress/factory cycles use.
   */
  sal_code: string;
  unitTypeKey: string;
  health: number;
  /**
   * Present whenever this unit is mid-travel between two suburbs (ANU-038's
   * travel-time system — originally reserved by ANU-014 for a drone-only
   * "in transit" GUI state before travel time existed at all; now set for
   * both drones and robots, since every move takes real time). Absent once
   * the unit has arrived and its move has resolved (moved/hit/kill — see
   * server/units.ts's settleArrivals) or if it has never moved.
   */
  destinationSalCode?: string;
  moveStartedAt?: string;
  /**
   * 0 (just dispatched) to 1 (about to arrive) — server-computed from
   * elapsedMs(moveStartedAt) against this unit type's travel time (distance
   * between sal_code and destinationSalCode, divided by its speed), same
   * "server does the GAME_TIME_SCALE-aware math, client just reads a plain
   * fraction" split FactoryProductionCycle.progressFraction/
   * SuburbCaptureState.progressFraction already use. Present iff
   * destinationSalCode is.
   */
  travelProgressFraction?: number;
}

export interface ServerOccupancy {
  type: "occupancy";
  lobbyId: string;
  units: OccupantUnit[];
}

/**
 * One buildable unit type's independent auto-production cycle at a factory
 * (ANU-022) — every buildable type (base roster plus any
 * `requires_skill_node` variant the factory's owner has unlocked) cycles
 * concurrently, not one queued type at a time, so this is an array on
 * FactoryState rather than the single `queuedUnitTypeKey` slot it replaces.
 */
export interface FactoryProductionCycle {
  unitTypeKey: string;
  /** 0 (cycle just started) to 1 (about to complete) — see server/factories.ts. */
  progressFraction: number;
}

export interface FactoryState {
  id: string;
  sal_code: string;
  ownerPlayerId: string;
  production: FactoryProductionCycle[];
}

export interface ServerFactories {
  type: "factories";
  lobbyId: string;
  factories: FactoryState[];
}

export interface UnitTypeCatalogEntry {
  key: string;
  health: number;
  damage: number;
  /** Scrap credited to whoever destroys a unit of this type (server/units.ts's attackSuburb) — no longer a build cost; units are auto-produced, not bought (ANU-022). */
  scrapValue: number;
  buildTimeMs: number;
  movementMode: "fly" | "ground";
  /**
   * Constant travel speed (ANU-038): map/SVG units (map-geometry.json's
   * label_point space) per game-ms. Travel time between two suburbs is
   * their label_point distance divided by this — see server/units.ts's
   * seedBaseUnitTypes for the chosen drone/robot values and why. The client
   * needs this to compute an in-transit unit's live progress fraction
   * itself (elapsedMs(moveStartedAt) / (distance / speed)), the same
   * derived-at-render-time pattern factory/capture progress already use.
   */
  speed: number;
  /** Non-null for an ANU-016 skill-tree-gated variant — a factory only auto-produces it once its owner has unlocked that node (server/factories.ts). */
  requiresSkillNode: string | null;
}

/**
 * Global reference data (ANU-020) — every `unit_types` row, so the GUI's
 * roster/combat displays show real stats instead of hardcoding values that
 * could drift from server/units.ts's seedBaseUnitTypes. Not lobby-scoped;
 * sent once per connection right after `welcome`.
 */
export interface ServerUnitCatalog {
  type: "unitCatalog";
  unitTypes: UnitTypeCatalogEntry[];
}

/**
 * A player's own scrap balance and current live TFLOPS (ANU-020; TFLOPS
 * reworked by ANU-019 from a stored balance to a live sum of currently-held
 * data centers — server/tflops.ts) — sent only to the owning player's
 * socket(s), never broadcast to the lobby like LobbyState is, since both are
 * private to that player.
 */
export interface ServerEconomy {
  type: "economy";
  scrap: number;
  tflops: number;
  /** ANU-042: this player's current auto-fortify preference, so a reconnecting client's control reflects it without a separate message. */
  autoFortifyMode: AutoFortifyMode;
}

/**
 * One suburb's in-progress capture (ANU-017) — sparse, like `occupancy`:
 * only suburbs currently being captured appear here at all (a settled,
 * uncontested, not-being-captured suburb is simply absent). `ownership`
 * (LobbyState) already carries who currently OWNS a suburb; this carries
 * who's trying to take it away, from whom, and how far along that attempt
 * is. `contestingPlayerIds` can hold more than one entry — confirmed with
 * the user that a suburb can be contested by more than one opposing player
 * at once (lobbies go up to 12), not just a single fixed contester.
 */
export interface SuburbCaptureState {
  sal_code: string;
  capturingPlayerId: string;
  contestingPlayerIds: string[];
  /** 0 (just started) to 1 (about to transfer) — frozen while contestingPlayerIds is non-empty. */
  progressFraction: number;
}

export interface ServerCaptures {
  type: "captures";
  lobbyId: string;
  captures: SuburbCaptureState[];
}

export interface ServerSkillTree {
  /**
   * The researching player's current unlocked-node set, in-progress
   * research (if any), resulting perk multipliers, and current live TFLOPS
   * (ANU-016, time-gated by ANU-019) — TFLOPS is included so the
   * client-side skillTreeVisual pure function and any future progress UI
   * can be fed directly from this one message. Broadcast only to the
   * researching player — other players' skill trees are independent
   * (server/skill-tree.ts is per-player, not shared within a lobby), unlike
   * ServerOccupancy/ServerFactories which are lobby-wide since
   * ownership/factories are visible to everyone.
   */
  type: "skillTree";
  playerId: string;
  unlockedNodeIds: string[];
  researching: { nodeId: string; startedAt: string; progressFraction: number } | null;
  multipliers: import("./perks.ts").PerkMultipliers;
  tflops: number;
  /**
   * `server/skill-tree.ts`'s `speedMultiplier(tflops)` curve, computed
   * server-side and sent alongside the raw `tflops` figure (ANU-031) so the
   * Research tab can show "holding this much TFLOPS gets you Nx research
   * speed" without the client reimplementing — and risking drifting from —
   * that curve itself.
   */
  speedMultiplier: number;
}

export interface LobbySummary {
  lobbyId: string;
  name: string;
  capacity: number;
  started: boolean;
  memberCount: number;
  onlineCount: number;
}

export interface ServerWelcome {
  type: "welcome";
  playerId: string;
  token: string;
  /**
   * The player's current lobby, or null if they aren't in one yet — `hello`
   * no longer auto-joins a default lobby, since there is nowhere to source
   * a per-lobby callsign from until the player has chosen a lobby to join
   * or create (see ADR 0002).
   */
  lobby: LobbyState | null;
}

export interface ServerLobbyState {
  type: "lobbyState";
  lobby: LobbyState;
}

export interface ServerLobbyList {
  type: "lobbyList";
  lobbies: LobbySummary[];
}

export interface ServerNameRequired {
  /**
   * The join/create the client just sent needs a `callsign` it didn't
   * provide (first join to this lobby). Distinct from `error` so the
   * client can prompt for a name in place, rather than `error`'s "bounce
   * to Browse" handling, which would lose a shared-lobby-link destination.
   */
  type: "nameRequired";
  lobbyId: string;
}

export interface ServerError {
  type: "error";
  message: string;
}

export type ServerMessage =
  | ServerWelcome
  | ServerLobbyState
  | ServerLobbyList
  | ServerNameRequired
  | ServerError
  | ServerOccupancy
  | ServerFactories
  | ServerUnitCatalog
  | ServerEconomy
  | ServerSkillTree
  | ServerCaptures;

const MAX_NAME_LENGTH = 40;
const MAX_TOKEN_LENGTH = 100;
const MAX_LOBBY_ID_LENGTH = 64;
const MAX_SAL_CODE_LENGTH = 16;
const MAX_UNIT_TYPE_KEY_LENGTH = 32;
const MAX_NODE_ID_LENGTH = 32;
// moveUnits' counts object: bounded defensively (there are only 2 seeded
// unit types today, ANU-016 variants stay in the single digits) rather than
// left unbounded, same reasoning every other array/object-shaped field in
// this parser gets a cap.
const MAX_MOVE_UNITS_TYPES = 32;
// A lobby's whole production run never approaches this per-order — bounds
// the field defensively against a malformed/hostile payload, not a real
// gameplay limit.
const MAX_MOVE_UNITS_COUNT = 100_000;
// PLAN.md "Players & spawn balance" (settled by ANU-006): games are 4-12
// players, minimum 4 to start. Tightened from ANU-008's placeholder 2-16
// range now that the real rule has landed.
export const MIN_CAPACITY = 4;
export const MAX_CAPACITY = 12;

// One color per lobby slot (MAX_CAPACITY of them), assigned in list order
// at join and locked for the lobby's lifetime — see ADR 0002's precedent
// for locking callsign the same way. Originally chosen to stay visually
// distinct from map.js's then-solid-color data-center tier markers on both
// axes (hue and rendered RGB distance) — spec/territory.test.ts asserted
// directly against this exported array. ANU-021 swapped those circles for
// tier-colored icons (server/public/data-center-visual.js's
// DATA_CENTER_TIER_COLORS); the
// icons' teal/crimson tints land close to this palette's own teal/crimson
// entries, so that hue/RGB guarantee no longer holds for every pair — see
// spec/territory.test.ts's own note on what it checks now instead
// (distinguishable by icon shape, not purely by color).
// Six base hues (each >=31 degrees apart from the other five — the
// smallest lobby's palette is maximally spread, not just "distinct from
// markers"), each at two lightness levels, ordered base hues first then
// their lighter variants — NOT grouped by hue pair, since a 4-6 player
// lobby (using only the first 4-6 entries) would otherwise get two
// near-identical-hue colors (e.g. two greens) before ever reaching a
// distinct sixth hue.
export const PLAYER_COLORS: readonly string[] = [
  "#30b319", // green, hue 111
  "#2419b3", // indigo, hue 244
  "#b31942", // crimson, hue 344
  "#7519b3", // violet, hue 276
  "#19b399", // teal, hue 170
  "#91b319", // olive, hue 73
  "#6be755", // light green, hue 111
  "#5f55e7", // periwinkle, hue 244
  "#e7557c", // rose, hue 344
  "#ad55e7", // light violet, hue 276
  "#55e7cf", // light teal, hue 170
  "#c7e755", // light olive, hue 73
];

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function parseClientMessage(raw: string): ClientMessage {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new Error("message has no 'type'");
  }
  const { type } = data as { type: unknown };

  if (type === "hello") {
    const { token } = data as Partial<ClientHello>;
    if (token !== undefined && !isNonEmptyString(token, MAX_TOKEN_LENGTH)) {
      throw new Error(`'hello.token', if present, must be a string up to ${MAX_TOKEN_LENGTH} characters`);
    }
    return { type: "hello", token };
  }

  if (type === "createLobby") {
    const { name, capacity, callsign } = data as Partial<ClientCreateLobby>;
    if (!isNonEmptyString(name, MAX_NAME_LENGTH)) {
      throw new Error(`'createLobby' requires a 'name' between 1 and ${MAX_NAME_LENGTH} characters`);
    }
    if (
      typeof capacity !== "number" ||
      !Number.isInteger(capacity) ||
      capacity < MIN_CAPACITY ||
      capacity > MAX_CAPACITY
    ) {
      throw new Error(`'createLobby' requires an integer 'capacity' between ${MIN_CAPACITY} and ${MAX_CAPACITY}`);
    }
    if (!isNonEmptyString(callsign, MAX_NAME_LENGTH)) {
      throw new Error(`'createLobby' requires a 'callsign' between 1 and ${MAX_NAME_LENGTH} characters`);
    }
    return { type: "createLobby", name, capacity, callsign };
  }

  if (type === "joinLobby") {
    const { lobbyId, callsign } = data as Partial<ClientJoinLobby>;
    if (!isNonEmptyString(lobbyId, MAX_LOBBY_ID_LENGTH)) {
      throw new Error("'joinLobby' requires a non-empty 'lobbyId'");
    }
    if (callsign !== undefined && !isNonEmptyString(callsign, MAX_NAME_LENGTH)) {
      throw new Error(`'joinLobby.callsign', if present, must be between 1 and ${MAX_NAME_LENGTH} characters`);
    }
    return { type: "joinLobby", lobbyId, callsign };
  }

  if (type === "startLobby") {
    return { type: "startLobby" };
  }

  if (type === "watchLobbies") {
    return { type: "watchLobbies" };
  }

  if (type === "unwatchLobbies") {
    return { type: "unwatchLobbies" };
  }

  if (type === "placeUnit") {
    const { sal_code, unitTypeKey } = data as Partial<ClientPlaceUnit>;
    if (!isNonEmptyString(sal_code, MAX_SAL_CODE_LENGTH)) {
      throw new Error("'placeUnit' requires a non-empty 'sal_code'");
    }
    if (!isNonEmptyString(unitTypeKey, MAX_UNIT_TYPE_KEY_LENGTH)) {
      throw new Error("'placeUnit' requires a non-empty 'unitTypeKey'");
    }
    return { type: "placeUnit", sal_code, unitTypeKey };
  }

  if (type === "moveUnits") {
    const { fromSalCode, toSalCode, counts } = data as Partial<ClientMoveUnits>;
    if (!isNonEmptyString(fromSalCode, MAX_SAL_CODE_LENGTH)) {
      throw new Error("'moveUnits' requires a non-empty 'fromSalCode'");
    }
    if (!isNonEmptyString(toSalCode, MAX_SAL_CODE_LENGTH)) {
      throw new Error("'moveUnits' requires a non-empty 'toSalCode'");
    }
    if (typeof counts !== "object" || counts === null || Array.isArray(counts)) {
      throw new Error("'moveUnits' requires a 'counts' object");
    }
    const countEntries = Object.entries(counts);
    if (countEntries.length > MAX_MOVE_UNITS_TYPES) {
      throw new Error(`'moveUnits.counts' must have at most ${MAX_MOVE_UNITS_TYPES} entries`);
    }
    for (const [unitTypeKey, count] of countEntries) {
      if (!isNonEmptyString(unitTypeKey, MAX_UNIT_TYPE_KEY_LENGTH)) {
        throw new Error("'moveUnits.counts' keys must be non-empty unit type keys");
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_MOVE_UNITS_COUNT) {
        throw new Error(`'moveUnits.counts' values must be integers between 0 and ${MAX_MOVE_UNITS_COUNT}`);
      }
    }
    return { type: "moveUnits", fromSalCode, toSalCode, counts: counts as Record<string, number> };
  }

  if (type === "buildFactory") {
    const { sal_code } = data as Partial<ClientBuildFactory>;
    if (!isNonEmptyString(sal_code, MAX_SAL_CODE_LENGTH)) {
      throw new Error("'buildFactory' requires a non-empty 'sal_code'");
    }
    return { type: "buildFactory", sal_code };
  }

  if (type === "startResearch") {
    const { nodeId } = data as Partial<ClientStartResearch>;
    if (!isNonEmptyString(nodeId, MAX_NODE_ID_LENGTH)) {
      throw new Error("'startResearch' requires a non-empty 'nodeId'");
    }
    return { type: "startResearch", nodeId };
  }

  if (type === "setAutoFortifyMode") {
    const { mode } = data as Partial<ClientSetAutoFortifyMode>;
    if (typeof mode !== "string" || !(AUTO_FORTIFY_MODES as readonly string[]).includes(mode)) {
      throw new Error(`'setAutoFortifyMode' requires 'mode' to be one of: ${AUTO_FORTIFY_MODES.join(", ")}`);
    }
    return { type: "setAutoFortifyMode", mode: mode as AutoFortifyMode };
  }

  throw new Error(`unknown message type: ${String(type)}`);
}
