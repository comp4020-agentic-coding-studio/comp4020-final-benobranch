// Checks ANU-027's moveUnits message end-to-end over the real WebSocket
// protocol — reachability/stock rejection and combat resolution are already
// covered directly against server/units.ts in spec/units.test.ts and
// spec/combat.test.ts, but nothing exercises the parser branch, the
// index.ts handler's broadcast/economy side effects, or a malformed payload
// closing the connection. Same connect/send/waitFor pattern as
// spec/skill-tree-protocol.test.ts.
//
// ANU-038: dispatch-only tests (immediate rejection, malformed payload) can
// still use the shared, unscaled spec/global-setup.ts APP_URL server —
// nothing here waits for an arrival. The one test that needs a unit to
// actually finish traveling (the kill test) spawns its own time-scaled
// server, same pattern spec/combat.test.ts/spec/economy-broadcast.test.ts
// document for the same reason.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, inject, it } from "vitest";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";

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

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

function connect(url: string, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
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

async function createStartedLobby(url: string, name: string): Promise<Client> {
  const creator = await connect(url);
  send(creator, { type: "createLobby", name, capacity: 4, callsign: "mover" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === name);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  return creator;
}

it("a valid moveUnits order broadcasts occupancy showing the unit dispatched (in transit, still at its origin)", async () => {
  const creator = await createStartedLobby(baseUrl, `moveunits-occupancy-${Date.now()}`);
  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  const targetSalCode = [...adjacency.get(spawnSalCode)!][0];

  send(creator, { type: "placeUnit", sal_code: spawnSalCode, unitTypeKey: "drone" });
  await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === spawnSalCode));

  send(creator, { type: "moveUnits", fromSalCode: spawnSalCode, toSalCode: targetSalCode, counts: { drone: 1 } });
  const dispatched = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { destinationSalCode?: string }[]).some((u) => u.destinationSalCode === targetSalCode));
  const unit = (dispatched.units as { sal_code: string; destinationSalCode?: string }[]).find((u) => u.destinationSalCode === targetSalCode)!;
  // Dispatch alone never relocates it (ANU-038's confirmed "resolve on
  // arrival" rule) — it's still at the ORIGIN, just now carrying a
  // destination.
  expect(unit.sal_code).toBe(spawnSalCode);

  await closeAndWait(creator);
});

it("a count exceeding what's present at fromSalCode is rejected with 'insufficient-units'", async () => {
  const creator = await createStartedLobby(baseUrl, `moveunits-insufficient-${Date.now()}`);
  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  const targetSalCode = [...adjacency.get(spawnSalCode)!][0];

  send(creator, { type: "placeUnit", sal_code: spawnSalCode, unitTypeKey: "drone" });
  await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === spawnSalCode));

  send(creator, { type: "moveUnits", fromSalCode: spawnSalCode, toSalCode: targetSalCode, counts: { drone: 5 } });
  const error = await waitFor(creator, (m) => m.type === "error");
  expect((error.message as string).toLowerCase()).toContain("insufficient-units");

  await closeAndWait(creator);
});

const killTestDataDir = mkdtempSync(join(tmpdir(), "anu038-moveunits-kill-"));
const killTestPort = 8110; // 8109 is spec/economy-broadcast.test.ts (ANU-038)
let killTestServer: SpawnedServer | undefined;
afterAll(async () => {
  await killTestServer?.stop();
  rmSync(killTestDataDir, { recursive: true, force: true });
});

it("a kill inside a moveUnits order sends economy to the attacker only, not to a bystander in the same lobby, once travel time elapses", async () => {
  // A high scale so a robot's design travel time resolves within a real
  // second or two over this fixture's distance — same reasoning
  // spec/combat.test.ts/spec/economy-broadcast.test.ts document.
  killTestServer = await spawnServer({ port: killTestPort, dataDir: killTestDataDir, gameTimeScale: 500 });
  const url = killTestServer.baseUrl;

  const lobbyName = `moveunits-kill-${Date.now()}`;
  const attacker = await connect(url);
  send(attacker, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "attacker" });
  const created = await waitFor(attacker, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  const bystander = await connect(url);
  send(bystander, { type: "joinLobby", lobbyId, callsign: "bystander" });
  await waitFor(bystander, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);

  send(attacker, { type: "startLobby" });
  await waitFor(attacker, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  await waitFor(bystander, (m) => m.type === "lobbyState" && (m.lobby as { started: boolean }).started);

  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  const targetSalCode = [...adjacency.get(spawnSalCode)!][0];

  send(attacker, { type: "placeUnit", sal_code: spawnSalCode, unitTypeKey: "robot" });
  await waitFor(attacker, (m) => m.type === "occupancy" && (m.units as { sal_code: string; ownerPlayerId: string }[]).some((u) => u.sal_code === spawnSalCode));

  // Clear history before the kill-seeking loop: startLobby already sent
  // attacker an `economy` message (scrap: 0), same reasoning
  // spec/economy-broadcast.test.ts's earnScrapByKilling documents.
  attacker.messages.length = 0;
  bystander.messages.length = 0;

  let scrap: number | undefined;
  for (let i = 0; i < 20 && scrap === undefined; i++) {
    send(bystander, { type: "placeUnit", sal_code: targetSalCode, unitTypeKey: "drone" });
    await waitFor(bystander, (m) => m.type === "occupancy", 1000);
    send(attacker, { type: "moveUnits", fromSalCode: spawnSalCode, toSalCode: targetSalCode, counts: { robot: 1 } });
    try {
      const economy = await waitFor(attacker, (m) => m.type === "economy", 1000);
      scrap = economy.scrap as number;
    } catch {
      // Survived the hit — not yet a kill. A "hit" outcome leaves the
      // attacker's sal_code unchanged and releases it from transit
      // (server/units.ts), so the next iteration's moveUnits can dispatch
      // it again against a fresh defender with no repositioning needed.
    }
  }
  expect(scrap, "attacker should have landed a kill within 20 attempts").toBeDefined();

  // The bystander, in the same lobby, must NOT have received any economy
  // message at any point — it's private to the player it belongs to.
  expect(bystander.messages.some((m) => m.type === "economy")).toBe(false);

  await closeAndWait(attacker);
  await closeAndWait(bystander);
}, 20_000);

it("a closing-socket message with a malformed moveUnits payload is rejected at parse time, not silently ignored", async () => {
  const creator = await connect(baseUrl);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    creator.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  // Missing required 'toSalCode' and 'counts'.
  creator.ws.send(JSON.stringify({ type: "moveUnits", fromSalCode: "80001-0" }));
  const { code } = await closed;
  expect(code).toBe(1008); // same policy-violation close code every other malformed message uses
});

it("a moveUnits payload with a non-integer count is rejected at parse time", async () => {
  const creator = await connect(baseUrl);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    creator.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  creator.ws.send(JSON.stringify({ type: "moveUnits", fromSalCode: "80001-0", toSalCode: "80001-1", counts: { drone: 1.5 } }));
  const { code } = await closed;
  expect(code).toBe(1008);
});
