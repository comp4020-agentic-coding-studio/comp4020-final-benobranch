// Wire shapes shared between the server and any client. Kept in one module
// so later subsystems (map/combat, UI) build against a single source of
// truth instead of each guessing the WebSocket message shape independently.
//
// This skeleton only proves the transport (multi-user identity, real-time
// fan-out, persistence) with a throwaway feature — a shared counter players
// can bump — not any game rule. Game messages replace `Bump`/`CounterState`
// later; the envelope and connection lifecycle stay.

export interface ClientHello {
  type: "hello";
  /** Display name the player sent; the server assigns the actual playerId. */
  name: string;
}

export interface ClientBump {
  type: "bump";
}

export type ClientMessage = ClientHello | ClientBump;

export interface ServerWelcome {
  type: "welcome";
  playerId: string;
  count: number;
  players: PlayerSummary[];
}

export interface ServerCounterState {
  type: "counter";
  count: number;
  lastBumpedBy: string | null;
}

export interface ServerPresence {
  type: "presence";
  players: PlayerSummary[];
}

export type ServerMessage = ServerWelcome | ServerCounterState | ServerPresence;

export interface PlayerSummary {
  playerId: string;
  name: string;
}

export function parseClientMessage(raw: string): ClientMessage {
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null || !("type" in data)) {
    throw new Error("message has no 'type'");
  }
  const { type } = data as { type: unknown };
  if (type === "hello") {
    const { name } = data as Partial<ClientHello>;
    if (typeof name !== "string" || name.length === 0 || name.length > 40) {
      throw new Error("'hello' requires a 'name' between 1 and 40 characters");
    }
    return { type: "hello", name };
  }
  if (type === "bump") {
    return { type: "bump" };
  }
  throw new Error(`unknown message type: ${String(type)}`);
}
