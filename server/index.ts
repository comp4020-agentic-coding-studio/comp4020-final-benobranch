// Backend skeleton: proves multi-user + real-time + persists end to end with
// a throwaway feature (a shared counter + a live player list) before any
// game rule exists. See issues/ANU-005.md and
// docs/adr/0001-persistence-and-realtime-stack.md.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { openStore } from "./store.ts";
import { renderReadmePage } from "./readme-page.ts";
import { serveStatic } from "./static-files.ts";
import {
  parseClientMessage,
  type PlayerSummary,
  type ServerMessage,
} from "./protocol.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const README_PATH = process.env.README_PATH ?? "README.md";
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? "server/public";

const store = openStore(`${DATA_DIR}/game.db`);

interface Connection {
  socket: WebSocket;
  playerId: string;
  name: string;
}

// One process, one in-memory connection set — there is exactly one server
// instance (fly.toml runs a single machine), so this is the whole picture of
// who's online, not a per-worker shard that would need reconciling.
const connections = new Map<string, Connection>();

function playerList(): PlayerSummary[] {
  return [...connections.values()].map(({ playerId, name }) => ({ playerId, name }));
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage, exclude?: WebSocket): void {
  const payload = JSON.stringify(message);
  for (const conn of connections.values()) {
    if (conn.socket !== exclude && conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(payload);
    }
  }
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
// in the "online" list long after that player is actually gone. Pinging
// every connection and terminating ones that didn't pong since the last
// check catches this — see the `ws` README's "how to detect and close
// broken connections" recipe.
const alive = new WeakSet<WebSocket>();

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!alive.has(client)) {
      client.terminate();
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

  // Identity for this skeleton is just "whoever connected with this socket" —
  // an anonymous visitor, matching the brief's "what counts as a person is
  // your call". Later subsystems can replace this with cookies/accounts
  // without changing the broadcast mechanism below.
  const playerId = randomUUID();
  let registered = false;

  socket.on("message", (raw) => {
    let message;
    try {
      message = parseClientMessage(raw.toString());
    } catch (err) {
      socket.close(1008, err instanceof Error ? err.message : "bad message");
      return;
    }

    if (message.type === "hello") {
      const conn: Connection = { socket, playerId, name: message.name };
      connections.set(playerId, conn);
      registered = true;

      const counter = store.getCounter();
      send(socket, {
        type: "welcome",
        playerId,
        count: counter.count,
        players: playerList(),
      });
      broadcast({ type: "presence", players: playerList() }, socket);
      return;
    }

    if (message.type === "bump") {
      if (!registered) {
        socket.close(1008, "send 'hello' before 'bump'");
        return;
      }
      const conn = connections.get(playerId);
      const name = conn?.name ?? "someone";
      // Synchronous store call: no await between the mutation and the
      // broadcast, so this handler can't interleave with another one on the
      // same event loop — see docs/adr/0001-persistence-and-realtime-stack.md.
      const counter = store.bump(name);
      broadcast({ type: "counter", count: counter.count, lastBumpedBy: counter.lastBumpedBy });
    }
  });

  socket.on("close", () => {
    if (registered) {
      connections.delete(playerId);
      broadcast({ type: "presence", players: playerList() });
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
