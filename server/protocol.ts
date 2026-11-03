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

export interface ClientMoveUnit {
  /** Same "any suburb" placeholder eligibility as placeUnit — see above. */
  type: "moveUnit";
  unitId: string;
  sal_code: string;
}

export type ClientMessage =
  | ClientHello
  | ClientCreateLobby
  | ClientJoinLobby
  | ClientStartLobby
  | ClientWatchLobbies
  | ClientUnwatchLobbies
  | ClientPlaceUnit
  | ClientMoveUnit;

export interface PlayerPresence {
  playerId: string;
  name: string;
  online: boolean;
  /** Assigned once at join (see ADR 0002's "locked in" precedent for callsign), unique per lobby. */
  color: string;
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
  sal_code: string;
  unitTypeKey: string;
  health: number;
}

export interface ServerOccupancy {
  type: "occupancy";
  lobbyId: string;
  units: OccupantUnit[];
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
  | ServerOccupancy;

const MAX_NAME_LENGTH = 40;
const MAX_TOKEN_LENGTH = 100;
const MAX_LOBBY_ID_LENGTH = 64;
const MAX_SAL_CODE_LENGTH = 16;
const MAX_UNIT_TYPE_KEY_LENGTH = 32;
const MAX_UNIT_ID_LENGTH = 64;
// PLAN.md "Players & spawn balance" (settled by ANU-006): games are 4-12
// players, minimum 4 to start. Tightened from ANU-008's placeholder 2-16
// range now that the real rule has landed.
export const MIN_CAPACITY = 4;
export const MAX_CAPACITY = 12;

// One color per lobby slot (MAX_CAPACITY of them), assigned in list order
// at join and locked for the lobby's lifetime — see ADR 0002's precedent
// for locking callsign the same way. Chosen to stay visually distinct from
// map.js's existing data-center tier marker colors (mega #ff4fd8 magenta,
// major #ffb23e amber, standard #6fa8ff blue) on BOTH axes a reviewer could
// reasonably check:
//   - hue: every color's hue is at least 28 degrees of circular distance
//     from all three marker hues (36/216/313 degrees) — six base hues, two
//     lightness levels each, chosen from the ~210 degrees of the wheel that
//     clears a 25-degree margin around every marker hue.
//   - rendered RGB: every color is at least 80 Euclidean RGB distance
//     (0-441 scale) from all three markers, and all 12 are at least 75
//     apart from each other.
// Ordered furthest-from-any-marker first, since a small lobby only ever
// assigns the first few entries. Both bounds above are exactly what
// spec/territory.test.ts asserts (importing this array directly, not
// re-parsing hex literals out of this file).
export const PLAYER_COLORS: readonly string[] = [
  "#30b319", // green, hue 111 (75 deg from nearest marker)
  "#2419b3", // indigo, hue 244 (28 deg from standard-blue 216)
  "#b31942", // crimson, hue 344 (31 deg from mega-magenta 313)
  "#6be755", // light green, hue 111
  "#7519b3", // violet, hue 276 (37 deg from standard-blue)
  "#19b399", // teal, hue 170 (46 deg from standard-blue)
  "#91b319", // olive, hue 73 (37 deg from major-amber 36)
  "#e7557c", // rose, hue 344
  "#5f55e7", // periwinkle, hue 244
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

  if (type === "moveUnit") {
    const { unitId, sal_code } = data as Partial<ClientMoveUnit>;
    if (!isNonEmptyString(unitId, MAX_UNIT_ID_LENGTH)) {
      throw new Error("'moveUnit' requires a non-empty 'unitId'");
    }
    if (!isNonEmptyString(sal_code, MAX_SAL_CODE_LENGTH)) {
      throw new Error("'moveUnit' requires a non-empty 'sal_code'");
    }
    return { type: "moveUnit", unitId, sal_code };
  }

  throw new Error(`unknown message type: ${String(type)}`);
}
