// Backend: persistent player identity + multiple lobbies over SQLite, real-
// time WebSocket fan-out scoped per lobby. See issues/ANU-008.md and
// docs/adr/0002-identity-and-lobbies.md for why this replaced ANU-005's
// single global counter and per-connection random playerId.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import { openStore, type StoredLobby } from "./store.ts";
import { createTerritory } from "./territory.ts";
import { createUnits, listUnitTypes } from "./units.ts";
import { createFactories } from "./factories.ts";
import { createSkillTree } from "./skill-tree.ts";
import { elapsedMs } from "./time.ts";
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
// Baked map data (scripts/map/build_lobby_config.py, build_geometry.py) —
// read-only reference data, not part of DATA_DIR's mutable game state.
const MAP_DATA_DIR = process.env.MAP_DATA_DIR ?? "scripts/map/data";

const store = openStore(`${DATA_DIR}/game.db`);
const territory = createTerritory(store.db);
const units = createUnits(store.db);
const factories = createFactories(store.db, units);
const skillTree = createSkillTree(store.db);

interface ConnMeta {
  playerId: string;
  /**
   * null until the player has joined or created a lobby — `hello` no
   * longer auto-joins one, since a per-lobby callsign (ADR 0002) has
   * nowhere to come from until the player picks a lobby.
   */
  lobbyId: string | null;
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
    started: lobby.started,
    startedAt: lobby.startedAt,
    gameElapsedMs: elapsedMs(lobby.startedAt),
    members: members.map((m) => ({ playerId: m.playerId, name: m.name, online: isOnline(m.playerId), color: m.color })),
    ownership: territory.getOwnership(lobby.lobbyId),
  };
}

function buildLobbySummary(lobby: StoredLobby): LobbySummary {
  const members = store.getLobbyMembers(lobby.lobbyId);
  return {
    lobbyId: lobby.lobbyId,
    name: lobby.name,
    capacity: lobby.capacity,
    started: lobby.started,
    memberCount: members.length,
    onlineCount: members.filter((m) => isOnline(m.playerId)).length,
  };
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function joinErrorMessage(reason: "not-found" | "full" | "started" | "name-taken"): string {
  if (reason === "full") return "that lobby is full";
  if (reason === "started") return "that game has already started";
  if (reason === "name-taken") return "that name is already taken in this lobby";
  return "no such lobby";
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

function broadcastOccupancy(lobbyId: string): void {
  const message: ServerMessage = { type: "occupancy", lobbyId, units: units.getOccupancy(lobbyId) };
  for (const socket of socketsInLobby(lobbyId)) send(socket, message);
}

function broadcastFactories(lobbyId: string): void {
  // getFactories settles any builds that finished since the last read, so
  // this also places the resulting unit (broadcastOccupancy below reflects
  // it) before reporting queue state.
  const message: ServerMessage = { type: "factories", lobbyId, factories: factories.getFactories(lobbyId) };
  for (const socket of socketsInLobby(lobbyId)) send(socket, message);
  broadcastOccupancy(lobbyId);
}

// A scrap/TFLOPS balance is private to the player it belongs to — unlike
// LobbyState (identical for every socket in a lobby), this is never
// broadcast, only sent to the owning player's own socket(s) (ANU-020).
function sendEconomyToPlayer(lobbyId: string, playerId: string): void {
  const economy = store.getMemberEconomy(lobbyId, playerId);
  if (!economy) return;
  const message: ServerMessage = { type: "economy", scrap: economy.scrap, tflops: economy.tflops };
  for (const [socket, meta] of sockets) {
    if (meta.lobbyId === lobbyId && meta.playerId === playerId) send(socket, message);
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

  // Baked map graph + geometry (ANU-006, ANU-010) — static reference data,
  // served from its own root rather than copied into server/public so the
  // one baked file isn't duplicated on disk.
  if (pathname === "/map/map.json" || pathname === "/map/map-geometry.json") {
    const file = serveStatic(MAP_DATA_DIR, pathname.replace(/^\/map/, ""));
    if (file) {
      res.writeHead(file.status, { "Content-Type": file.contentType });
      res.end(file.body);
      return;
    }
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

// A wake-up to settle+broadcast factory production cycles that complete
// with nobody having sent a message in the meantime — holds no build state
// itself (that lives in `factory_production`'s stored cycle_started_at
// timestamps, read via elapsedMs), so it's not the "armed timer" ADR 0001's
// stored-timestamp rule warns against: if this tick never fired (e.g. the
// machine was asleep), the next getFactories/hello call still computes the
// right elapsed progress from the stored timestamp. Only ticks lobbies with
// at least one live connection, matching spec/realtime.test.ts's ~1s
// broadcast target.
const factoryTicker = setInterval(() => {
  const liveLobbyIds = new Set([...sockets.values()].map((m) => m.lobbyId).filter((id): id is string => id !== null));
  for (const lobbyId of liveLobbyIds) {
    if (store.getLobby(lobbyId)?.started) broadcastFactories(lobbyId);
  }
}, 1000);
factoryTicker.unref();

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
      const { playerId, token } = store.resolvePlayer(message.token);
      const lobbyId = store.getCurrentLobbyId(playerId); // null if they've never joined one
      const lobby = lobbyId ? store.getLobby(lobbyId) : null;

      sockets.set(socket, { playerId, lobbyId, registered: true, watchingLobbies: false });

      send(socket, { type: "welcome", playerId, token, lobby: lobby ? buildLobbyState(lobby) : null });
      // Global reference data (ANU-020) — not lobby-scoped, so this is sent
      // unconditionally rather than gated on lobbyId like the three below.
      send(socket, { type: "unitCatalog", unitTypes: listUnitTypes(store.db) });
      // A reconnecting client needs current occupancy and factory state too,
      // not just lobby state — both otherwise only arrive on the next
      // change broadcast, which a client that was offline when it happened
      // would miss. getFactories settles any builds completed while nobody
      // was connected (the stored-timestamp rule means that's fine).
      if (lobbyId) send(socket, { type: "occupancy", lobbyId, units: units.getOccupancy(lobbyId) });
      if (lobbyId) send(socket, { type: "factories", lobbyId, factories: factories.getFactories(lobbyId) });
      if (lobbyId) sendEconomyToPlayer(lobbyId, playerId);
      if (lobbyId) {
        send(socket, {
          type: "skillTree",
          playerId,
          unlockedNodeIds: skillTree.getUnlockedNodeIds(lobbyId, playerId),
          multipliers: store.perks.getPerkMultipliers(lobbyId, playerId),
          tflops: store.getMemberEconomy(lobbyId, playerId)?.tflops ?? 0,
        });
      }
      if (lobbyId) broadcastLobbyState(lobbyId); // this player's online status just changed
      return;
    }

    const meta = sockets.get(socket);
    if (!meta?.registered) {
      socket.close(1008, "send 'hello' first");
      return;
    }

    if (message.type === "createLobby") {
      const lobby = store.createLobby(message.name, message.capacity, meta.playerId, message.callsign);
      moveAllSocketsForPlayer(meta.playerId, meta.lobbyId, lobby.lobbyId);
      return;
    }

    if (message.type === "joinLobby") {
      const fromLobbyId = meta.lobbyId;
      const result = store.joinLobby(meta.playerId, message.lobbyId, message.callsign);
      if (!result.ok) {
        if (result.reason === "name-required") {
          send(socket, { type: "nameRequired", lobbyId: result.lobbyId });
        } else {
          send(socket, { type: "error", message: joinErrorMessage(result.reason) });
        }
        return;
      }
      moveAllSocketsForPlayer(meta.playerId, fromLobbyId, message.lobbyId);
      return;
    }

    if (message.type === "startLobby") {
      if (!meta.lobbyId) return;
      const lobby = store.startLobby(meta.lobbyId);
      if (lobby) {
        // Spawn suburbs auto-owned at kickoff (issues/ANU-013.md) — in join
        // order, against this lobby's own capacity's spawn table.
        const memberPlayerIds = store.getLobbyMembers(lobby.lobbyId).map((m) => m.playerId);
        territory.assignSpawnOwnership(lobby.lobbyId, memberPlayerIds);
        // One factory per player at their just-assigned spawn (issues/ANU-015.md) —
        // reads suburb_ownership back rather than recomputing the spawn
        // table itself, so it can't drift from territory.ts's own result.
        factories.spawnFactories(lobby.lobbyId, memberPlayerIds);
        broadcastLobbyState(meta.lobbyId);
        broadcastLobbyList(); // the browse list also shows started/not-started
        broadcastFactories(meta.lobbyId);
        // Primes every member's sidebar economy readout before any
        // build/attack action would otherwise change it (ANU-020).
        for (const playerId of memberPlayerIds) sendEconomyToPlayer(lobby.lobbyId, playerId);
      }
      return;
    }

    if (message.type === "placeUnit") {
      if (!meta.lobbyId || !store.getLobby(meta.lobbyId)?.started) return; // occupancy only makes sense once a game is running
      const result = units.placeUnit(meta.lobbyId, meta.playerId, message.sal_code, message.unitTypeKey);
      if (!result.ok) {
        send(socket, { type: "error", message: `placeUnit: ${result.reason}` });
        return;
      }
      broadcastOccupancy(meta.lobbyId);
      return;
    }

    if (message.type === "moveUnit") {
      if (!meta.lobbyId || !store.getLobby(meta.lobbyId)?.started) return;
      const result = units.moveUnit(meta.lobbyId, meta.playerId, message.unitId, message.sal_code);
      if (!result.ok) {
        send(socket, { type: "error", message: `moveUnit: ${result.reason}` });
        return;
      }
      broadcastOccupancy(meta.lobbyId);
      return;
    }

    if (message.type === "attackSuburb") {
      if (!meta.lobbyId || !store.getLobby(meta.lobbyId)?.started) return;
      const result = units.attackSuburb(meta.lobbyId, meta.playerId, message.unitId, message.sal_code);
      if (!result.ok) {
        send(socket, { type: "error", message: `attackSuburb: ${result.reason}` });
        return;
      }
      broadcastOccupancy(meta.lobbyId);
      // A kill credits scrap (server/units.ts) — update the attacker's own
      // sidebar economy readout (ANU-020); move/hit outcomes don't change it.
      if (result.outcome === "kill") sendEconomyToPlayer(meta.lobbyId, meta.playerId);
      return;
    }

    if (message.type === "buildFactory") {
      if (!meta.lobbyId || !store.getLobby(meta.lobbyId)?.started) return;
      const result = factories.buildFactory(meta.lobbyId, meta.playerId, message.sal_code);
      if (!result.ok) {
        send(socket, { type: "error", message: `buildFactory: ${result.reason}` });
        return;
      }
      broadcastFactories(meta.lobbyId);
      sendEconomyToPlayer(meta.lobbyId, meta.playerId); // deducted FACTORY_BUILD_COST_SCRAP
      return;
    }

    if (message.type === "purchaseNode") {
      if (!meta.lobbyId || !store.getLobby(meta.lobbyId)?.started) return;
      const result = skillTree.purchaseNode(meta.lobbyId, meta.playerId, message.nodeId);
      if (!result.ok) {
        send(socket, { type: "error", message: `purchaseNode: ${result.reason}` });
        return;
      }
      // Per-player, not lobby-wide (server/skill-tree.ts is per-player
      // state) — only the purchasing player's own sockets need the result.
      const tflops = store.getMemberEconomy(meta.lobbyId, meta.playerId)?.tflops ?? 0;
      for (const [otherSocket, otherMeta] of sockets) {
        if (otherMeta.playerId === meta.playerId) {
          send(otherSocket, {
            type: "skillTree",
            playerId: meta.playerId,
            unlockedNodeIds: result.unlockedNodeIds,
            multipliers: result.multipliers,
            tflops,
          });
        }
      }
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
    if (meta?.registered && meta.lobbyId && !isOnline(meta.playerId)) {
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
  clearInterval(factoryTicker);
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
