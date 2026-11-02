// Backend: persistent player identity + multiple lobbies over SQLite, real-
// time WebSocket fan-out scoped per lobby. See issues/ANU-008.md and
// docs/adr/0002-identity-and-lobbies.md for why this replaced ANU-005's
// single global counter and per-connection random playerId.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { DEFAULT_LOBBY_ID, openStore, type StoredLobby } from "./store.ts";
import { renderReadmePage } from "./readme-page.ts";
import { serveStatic } from "./static-files.ts";
import {
  parseClientMessage,
  type LobbySummary,
  type LobbyState,
  type ServerMessage,
} from "./protocol.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const README_PATH = process.env.README_PATH ?? "README.md";
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? "server/public";

const store = openStore(`${DATA_DIR}/game.db`);

interface ConnMeta {
  playerId: string;
  name: string;
  lobbyId: string;
  registered: boolean;
  watchingLobbies: boolean;
}

// One process, one in-memory connection registry — there is exactly one
// server instance (fly.toml runs a single machine). This is the single
// source of truth for "who's online and watching what"; lobby *membership*
// (who belongs to which lobby) lives in SQLite (server/store.ts) so it
// survives a restart, but which of those members currently has a live
// socket does not need to, and is recomputed from this Map on every
// broadcast.
const sockets = new Map<WebSocket, ConnMeta>();

function isOnline(playerId: string): boolean {
  for (const meta of sockets.values()) {
    if (meta.playerId === playerId) return true;
  }
  return false;
}

function socketsInLobby(lobbyId: string): WebSocket[] {
  return [...sockets.entries()].filter(([, meta]) => meta.lobbyId === lobbyId).map(([s]) => s);
}

function buildLobbyState(lobby: StoredLobby): LobbyState {
  const members = store.getLobbyMembers(lobby.lobbyId);
  return {
    lobbyId: lobby.lobbyId,
    name: lobby.name,
    capacity: lobby.capacity,
    count: lobby.count,
    lastBumpedBy: lobby.lastBumpedBy,
    members: members.map((m) => ({ playerId: m.playerId, name: m.name, online: isOnline(m.playerId) })),
  };
}

function buildLobbySummary(lobby: StoredLobby): LobbySummary {
  const members = store.getLobbyMembers(lobby.lobbyId);
  return {
    lobbyId: lobby.lobbyId,
    name: lobby.name,
    capacity: lobby.capacity,
    memberCount: members.length,
    onlineCount: members.filter((m) => isOnline(m.playerId)).length,
  };
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcastLobbyState(lobbyId: string): void {
  const lobby = store.getLobby(lobbyId);
  if (!lobby) return; // lobby was never created, or this id is stale
  const message: ServerMessage = { type: "lobbyState", lobby: buildLobbyState(lobby) };
  for (const socket of socketsInLobby(lobbyId)) send(socket, message);
}

function broadcastLobbyList(): void {
  const lobbies: LobbySummary[] = store.listLobbies().map(buildLobbySummary);
  const message: ServerMessage = { type: "lobbyList", lobbies };
  for (const [socket, meta] of sockets) {
    if (meta.watchingLobbies) send(socket, message);
  }
}

// Moves every live socket belonging to `playerId` from `fromLobbyId` to
// `toLobbyId` (a player has exactly one lobby membership at a time — see
// store.ts's joinLobby — so every one of their tabs follows the move) and
// re-broadcasts lobby state to whichever lobbies actually changed members.
function moveAllSocketsForPlayer(playerId: string, fromLobbyId: string | null, toLobbyId: string): void {
  for (const meta of sockets.values()) {
    if (meta.playerId === playerId) meta.lobbyId = toLobbyId;
  }
  if (fromLobbyId && fromLobbyId !== toLobbyId) broadcastLobbyState(fromLobbyId);
  broadcastLobbyState(toLobbyId);
  broadcastLobbyList();
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname === "/readme/") {
    const readme = readFileSync(README_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderReadmePage(readme));
    return;
  }

  const file = serveStatic(PUBLIC_DIR, pathname);
  if (file) {
    res.writeHead(file.status, { "Content-Type": file.contentType });
    res.end(file.body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

// A dropped wifi connection or a sleeping phone doesn't fire a 'close' event
// until TCP eventually times out (minutes), which would leave a ghost entry
// marked online long after that player is actually gone. Pinging every
// connection and terminating ones that didn't pong since the last check
// catches this — see the `ws` README's "how to detect and close broken
// connections" recipe.
const alive = new WeakSet<WebSocket>();

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!alive.has(client)) {
      client.terminate(); // triggers the 'close' handler below, which updates online status
      continue;
    }
    alive.delete(client);
    client.ping();
  }
}, 30_000);
heartbeat.unref();

wss.on("connection", (socket) => {
  alive.add(socket);
  socket.on("pong", () => alive.add(socket));

  socket.on("message", (raw) => {
    let message;
    try {
      message = parseClientMessage(raw.toString());
    } catch (err) {
      socket.close(1008, err instanceof Error ? err.message : "bad message");
      return;
    }

    if (message.type === "hello") {
      const { playerId, token } = store.resolvePlayer(message.name, message.token);

      let lobbyId = store.getCurrentLobbyId(playerId);
      if (!lobbyId) {
        const joined = store.joinLobby(playerId, DEFAULT_LOBBY_ID);
        if (!joined.ok) {
          // Default lobby is full — a real capacity ceiling, not expected at
          // this project's 5+-concurrent-player target but handled rather
          // than left to crash.
          socket.close(1013, "no lobby available to join");
          return;
        }
        lobbyId = DEFAULT_LOBBY_ID;
      }

      sockets.set(socket, { playerId, name: message.name, lobbyId, registered: true, watchingLobbies: false });

      const lobby = store.getLobby(lobbyId);
      if (!lobby) throw new Error(`player resolved into lobby '${lobbyId}' that doesn't exist`);

      send(socket, { type: "welcome", playerId, token, lobby: buildLobbyState(lobby) });
      broadcastLobbyState(lobbyId); // this player's online status just changed
      return;
    }

    const meta = sockets.get(socket);
    if (!meta?.registered) {
      socket.close(1008, "send 'hello' first");
      return;
    }

    if (message.type === "bump") {
      // Synchronous store call: no await between the mutation and the
      // broadcast, so this handler can't interleave with another one on the
      // same event loop — see docs/adr/0001-persistence-and-realtime-stack.md.
      const lobby = store.bump(meta.lobbyId, meta.name);
      if (lobby) broadcastLobbyState(meta.lobbyId);
      return;
    }

    if (message.type === "createLobby") {
      const lobby = store.createLobby(message.name, message.capacity);
      const fromLobbyId = meta.lobbyId;
      store.joinLobby(meta.playerId, lobby.lobbyId); // creator joins their own lobby
      moveAllSocketsForPlayer(meta.playerId, fromLobbyId, lobby.lobbyId);
      return;
    }

    if (message.type === "joinLobby") {
      const fromLobbyId = meta.lobbyId;
      const result = store.joinLobby(meta.playerId, message.lobbyId);
      if (!result.ok) {
        send(socket, { type: "error", message: result.reason === "full" ? "that lobby is full" : "no such lobby" });
        return;
      }
      moveAllSocketsForPlayer(meta.playerId, fromLobbyId, message.lobbyId);
      return;
    }

    if (message.type === "watchLobbies") {
      meta.watchingLobbies = true;
      send(socket, { type: "lobbyList", lobbies: store.listLobbies().map(buildLobbySummary) });
      return;
    }

    if (message.type === "unwatchLobbies") {
      meta.watchingLobbies = false;
    }
  });

  socket.on("close", () => {
    const meta = sockets.get(socket);
    sockets.delete(socket);
    // Only re-broadcast if this was this player's last open socket —
    // isOnline() already reflects the deletion above.
    if (meta?.registered && !isOnline(meta.playerId)) {
      broadcastLobbyState(meta.lobbyId);
      broadcastLobbyList();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`listening on 0.0.0.0:${PORT}, data dir ${DATA_DIR}`);
});

// Fly stops the machine with SIGTERM when it's idle (auto_stop_machines) or
// redeploying; close the db cleanly so WAL checkpoints rather than leaving a
// stale -wal file for the next boot to replay.
function shutdown(): void {
  clearInterval(heartbeat);
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
