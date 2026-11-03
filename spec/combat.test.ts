// Checks ANU-014's attackSuburb message over the real WebSocket protocol:
// accept/reject on movement-mode reachability only (drone vs. non-adjacent
// target, robot rejected there, robot vs. an adjacent owned-corridor
// target). Combat's random element itself (who wins a contested hit) is
// NOT asserted here — that needs an injectable rng, which no message
// carries, so it's covered directly against server/units.ts in
// spec/units.test.ts instead.
import { readFileSync } from "node:fs";
import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");

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

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

function connect(token?: string): Promise<Client> {
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

function waitFor(client: Client, predicate: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
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

async function createStartedLobby(name: string): Promise<Client> {
  const creator = await connect();
  send(creator, { type: "createLobby", name, capacity: 4, callsign: "attacker" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === name);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  return creator;
}

it("a drone's attackSuburb succeeds against a suburb with no road adjacency to the attacker's territory", async () => {
  const creator = await createStartedLobby(`combat-drone-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: SPAWN_SAL_CODE, unitTypeKey: "drone" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === SPAWN_SAL_CODE));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === SPAWN_SAL_CODE)!.id;

  send(creator, { type: "attackSuburb", unitId, sal_code: NON_ADJACENT_SAL_CODE });
  const moved = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === NON_ADJACENT_SAL_CODE));
  expect((moved.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === NON_ADJACENT_SAL_CODE)).toBe(true);

  await closeAndWait(creator);
});

it("a robot's attackSuburb against the same non-adjacent target is rejected", async () => {
  const creator = await createStartedLobby(`combat-robot-reject-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: SPAWN_SAL_CODE, unitTypeKey: "robot" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === SPAWN_SAL_CODE));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === SPAWN_SAL_CODE)!.id;

  send(creator, { type: "attackSuburb", unitId, sal_code: NON_ADJACENT_SAL_CODE });
  const error = await waitFor(creator, (m) => m.type === "error");
  expect((error.message as string).toLowerCase()).toContain("unreachable");

  await closeAndWait(creator);
});

it("a robot's attackSuburb against an adjacent, owned-corridor target succeeds", async () => {
  const creator = await createStartedLobby(`combat-robot-accept-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: SPAWN_SAL_CODE, unitTypeKey: "robot" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === SPAWN_SAL_CODE));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === SPAWN_SAL_CODE)!.id;

  send(creator, { type: "attackSuburb", unitId, sal_code: ADJACENT_SAL_CODE });
  const moved = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === ADJACENT_SAL_CODE));
  expect((moved.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === ADJACENT_SAL_CODE)).toBe(true);

  await closeAndWait(creator);
});
