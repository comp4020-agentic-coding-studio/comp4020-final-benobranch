// Checks ANU-014's movement-mode reachability rule over the real WebSocket
// protocol, via ANU-027's moveUnits message (the only wire-level way to
// move/attack as of that issue — the old one-unit-at-a-time moveUnit/
// attackSuburb messages were removed): accept/reject on reachability only
// (drone vs. non-adjacent target, robot rejected there, robot vs. an
// adjacent owned-corridor target). Combat's random element itself (who wins
// a contested hit) is NOT asserted here — that needs an injectable rng,
// which no message carries, so it's covered directly against
// server/units.ts in spec/units.test.ts instead.
//
// ANU-038: a moveUnits order now only dispatches — the unit doesn't actually
// relocate until its travel time elapses. Rather than sleeping out a real
// drone/robot flight (seconds to minutes at the seeded speeds, server/units.ts),
// this spawns its own server with a high GAME_TIME_SCALE (spec/lib/spawn-server.ts,
// same pattern as spec/capture.test.ts/spec/factories-restart.test.ts) so
// the same design travel time elapses in a small real sleep instead of the
// shared, unscaled spec/global-setup.ts APP_URL server.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";

interface MapFixture {
  suburbs: { idx: number; sal_code: string; name: string }[];
  edges: { a: number; b: number }[];
  spawn_table_by_lobby_size: Record<string, { spawns: string[] }>;
}

const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as MapFixture;
const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));
const idxToSalCode = new Map(mapData.suburbs.map((s) => [s.idx, s.sal_code]));

const adjacency = new Map<string, Set<string>>();
for (const edge of mapData.edges) {
  const a = idxToSalCode.get(edge.a)!;
  const b = idxToSalCode.get(edge.b)!;
  if (!adjacency.has(a)) adjacency.set(a, new Set());
  if (!adjacency.has(b)) adjacency.set(b, new Set());
  adjacency.get(a)!.add(b);
  adjacency.get(b)!.add(a);
}

// A single-player lobby of capacity 4 spawns its creator at this lobby
// size's first spawn entry (server/territory.ts).
const SPAWN_SAL_CODE = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
const ADJACENT_SAL_CODE = [...adjacency.get(SPAWN_SAL_CODE)!][0];
const NON_ADJACENT_SAL_CODE = mapData.suburbs.find(
  (s) => s.sal_code !== SPAWN_SAL_CODE && !adjacency.get(SPAWN_SAL_CODE)!.has(s.sal_code),
)!.sal_code;

const dataDir = mkdtempSync(join(tmpdir(), "anu038-combat-"));
const port = 8108; // 8107 is spec/capture.test.ts (ANU-017)
// A high scale so even the slowest archetype's (robot's) travel time over
// the longest fixture distance this file uses resolves well within a
// couple of real seconds, without needing per-distance tuning.
const SCALE = 500;
let server: SpawnedServer;
afterAll(async () => {
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

function connect(baseUrl: string, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token })));
    const client = { ws, messages };
    waitFor(client, (m) => m.type === "welcome").then(() => resolve(client), reject);
  });
}

function send(client: Client, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message));
}

function waitFor(client: Client, predicate: (m: ServerMessage) => boolean, timeoutMs = 4000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      const found = client.messages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for message"));
      setTimeout(check, 20);
    };
    check();
  });
}

async function closeAndWait(client: Client): Promise<void> {
  client.ws.close();
  await new Promise((resolve) => client.ws.once("close", resolve));
}

async function createStartedLobby(baseUrl: string, name: string): Promise<Client> {
  const creator = await connect(baseUrl);
  send(creator, { type: "createLobby", name, capacity: 4, callsign: "attacker" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === name);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  return creator;
}

it("a drone's moveUnits order succeeds against a suburb with no road adjacency to the attacker's territory, once travel time elapses", async () => {
  server = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  const creator = await createStartedLobby(server.baseUrl, `combat-drone-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: SPAWN_SAL_CODE, unitTypeKey: "drone" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === SPAWN_SAL_CODE));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === SPAWN_SAL_CODE)!.id;

  send(creator, { type: "moveUnits", fromSalCode: SPAWN_SAL_CODE, toSalCode: NON_ADJACENT_SAL_CODE, counts: { drone: 1 } });
  // First broadcast: dispatched, still at the origin, carrying a destination.
  const dispatched = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { id: string; destinationSalCode?: string }[]).some((u) => u.id === unitId && u.destinationSalCode === NON_ADJACENT_SAL_CODE));
  expect((dispatched.units as { id: string; sal_code: string }[]).find((u) => u.id === unitId)!.sal_code).toBe(SPAWN_SAL_CODE);

  // Later broadcast (the ~1s arrivalTicker, scaled way past this fixture's
  // travel time): arrived, relocated, no longer carrying a destination.
  const moved = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === NON_ADJACENT_SAL_CODE));
  expect((moved.units as { id: string; destinationSalCode?: string }[]).find((u) => u.id === unitId)!.destinationSalCode).toBeUndefined();

  await closeAndWait(creator);
});

it("a robot's moveUnits order against the same non-adjacent target is rejected", async () => {
  const creator = await createStartedLobby(server.baseUrl, `combat-robot-reject-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: SPAWN_SAL_CODE, unitTypeKey: "robot" });
  await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === SPAWN_SAL_CODE));

  send(creator, { type: "moveUnits", fromSalCode: SPAWN_SAL_CODE, toSalCode: NON_ADJACENT_SAL_CODE, counts: { robot: 1 } });
  const error = await waitFor(creator, (m) => m.type === "error");
  expect((error.message as string).toLowerCase()).toContain("unreachable");

  await closeAndWait(creator);
});

it("a robot's moveUnits order against an adjacent, owned-corridor target succeeds, once travel time elapses", async () => {
  const creator = await createStartedLobby(server.baseUrl, `combat-robot-accept-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: SPAWN_SAL_CODE, unitTypeKey: "robot" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === SPAWN_SAL_CODE));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === SPAWN_SAL_CODE)!.id;

  send(creator, { type: "moveUnits", fromSalCode: SPAWN_SAL_CODE, toSalCode: ADJACENT_SAL_CODE, counts: { robot: 1 } });
  const moved = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === ADJACENT_SAL_CODE));
  expect((moved.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === ADJACENT_SAL_CODE)).toBe(true);

  await closeAndWait(creator);
});
