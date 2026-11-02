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
  /** Display name the player sent; the server assigns the actual playerId. */
  name: string;
  /**
   * Secret token from a previous `welcome`, stored client-side, to resume
   * the same playerId/lobby rather than being treated as a brand-new
   * player. Absent (or no longer valid) on a first-ever visit.
   */
  token?: string;
}

export interface ClientBump {
  type: "bump";
}

export interface ClientCreateLobby {
  type: "createLobby";
  name: string;
  capacity: number;
}

export interface ClientJoinLobby {
  type: "joinLobby";
  lobbyId: string;
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
  count: number;
  lastBumpedBy: string | null;
  members: PlayerPresence[];
}

export interface LobbySummary {
  lobbyId: string;
  name: string;
  capacity: number;
  memberCount: number;
  onlineCount: number;
}

export interface ServerWelcome {
  type: "welcome";
  playerId: string;
  token: string;
  lobby: LobbyState;
}

export interface ServerLobbyState {
  type: "lobbyState";
  lobby: LobbyState;
}

export interface ServerLobbyList {
  type: "lobbyList";
  lobbies: LobbySummary[];
}

export interface ServerError {
  type: "error";
  message: string;
}

export type ServerMessage = ServerWelcome | ServerLobbyState | ServerLobbyList | ServerError;

const MAX_NAME_LENGTH = 40;
const MAX_TOKEN_LENGTH = 100;
const MAX_LOBBY_ID_LENGTH = 64;
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 16;

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
    const { name, token } = data as Partial<ClientHello>;
    if (!isNonEmptyString(name, MAX_NAME_LENGTH)) {
      throw new Error(`'hello' requires a 'name' between 1 and ${MAX_NAME_LENGTH} characters`);
    }
    if (token !== undefined && !isNonEmptyString(token, MAX_TOKEN_LENGTH)) {
      throw new Error(`'hello.token', if present, must be a string up to ${MAX_TOKEN_LENGTH} characters`);
    }
    return { type: "hello", name, token };
  }

  if (type === "bump") {
    return { type: "bump" };
  }

  if (type === "createLobby") {
    const { name, capacity } = data as Partial<ClientCreateLobby>;
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
    return { type: "createLobby", name, capacity };
  }

  if (type === "joinLobby") {
    const { lobbyId } = data as Partial<ClientJoinLobby>;
    if (!isNonEmptyString(lobbyId, MAX_LOBBY_ID_LENGTH)) {
      throw new Error("'joinLobby' requires a non-empty 'lobbyId'");
    }
    return { type: "joinLobby", lobbyId };
  }

  if (type === "watchLobbies") {
    return { type: "watchLobbies" };
  }

  if (type === "unwatchLobbies") {
    return { type: "unwatchLobbies" };
  }

  throw new Error(`unknown message type: ${String(type)}`);
}
