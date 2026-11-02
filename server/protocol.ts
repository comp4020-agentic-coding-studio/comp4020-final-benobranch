// Wire shapes shared between the server and any client. Kept in one module
// so later subsystems (map/combat, UI) build against a single source of
// truth instead of each guessing the WebSocket message shape independently.
//
// This still isn't game rules — it's the multi-lobby, persistent-identity
// skeleton ANU-009's Home/Browse/HUD screens render against. The counter is
// still a throwaway stand-in for real game state, now scoped per lobby
// instead of global, so lobby isolation is provable.

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

export interface ClientBump {
  type: "bump";
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

export type ClientMessage =
  | ClientHello
  | ClientBump
  | ClientCreateLobby
  | ClientJoinLobby
  | ClientStartLobby
  | ClientWatchLobbies
  | ClientUnwatchLobbies;

export interface PlayerPresence {
  playerId: string;
  name: string;
  online: boolean;
}

export interface LobbyState {
  lobbyId: string;
  name: string;
  capacity: number;
  started: boolean;
  count: number;
  lastBumpedBy: string | null;
  members: PlayerPresence[];
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
  | ServerError;

const MAX_NAME_LENGTH = 40;
const MAX_TOKEN_LENGTH = 100;
const MAX_LOBBY_ID_LENGTH = 64;
// PLAN.md "Players & spawn balance" (settled by ANU-006): games are 4-12
// players, minimum 4 to start. Tightened from ANU-008's placeholder 2-16
// range now that the real rule has landed.
export const MIN_CAPACITY = 4;
export const MAX_CAPACITY = 12;

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

  if (type === "bump") {
    return { type: "bump" };
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

  throw new Error(`unknown message type: ${String(type)}`);
}
