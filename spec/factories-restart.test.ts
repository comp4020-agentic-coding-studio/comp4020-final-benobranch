// Checks ANU-022's auto-production cycles survive a real process restart
// mid-cycle with correctly scaled elapsed progress (not reset or lost) —
// same style as spec/territory.test.ts's and spec/persistence.test.ts's
// restart tests. Unlike ANU-015's original scrap-queued model this
// replaced, no action is needed to start production: a factory's cycles
// begin the moment it exists (spawnFactories at kickoff), so this test just
// has to let real time pass across a restart and check progress continued
// from where it left off. Spawns its own server (spec/global-setup.ts's
// APP_URL server can't be restarted from inside a test) against a scratch
// port/DATA_DIR.
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";

const dataDir = mkdtempSync(join(tmpdir(), "anu022-factory-restart-"));
const port = 8104;

const servers: SpawnedServer[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop();
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

interface FactoryMsgShape {
  id: string;
  production: { unitTypeKey: string; progressFraction: number }[];
}

it("a factory's auto-production cycle survives a real process restart mid-cycle with correct elapsed progress, not reset or lost", async () => {
  // A LOW scale (robot's 120,000ms/2min design duration stretched even
  // further in real time) ensures the cycle genuinely can't finish during
  // the brief restart window — same reasoning spec/territory.test.ts's
  // restart test documents for its own scale choice, just in the opposite
  // direction (that test speeds time up; this one needs it slowed down so a
  // cycle in progress stays in progress across the restart).
  const SCALE = 0.1;
  const first = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(first);

  const lobbyName = `factory-restart-${Date.now()}`;
  const creator = await connect(first.baseUrl);
  const welcome = creator.messages.find((m) => m.type === "welcome")!;
  const creatorToken = welcome.token as string;
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "factory-creator" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  // spawnFactories starts every buildable type's cycle immediately — no
  // queueUnit action needed (ANU-022 removed it).
  const factoriesMsg = await waitFor(creator, (m) => m.type === "factories" && (m.lobbyId as string) === lobbyId);
  const factory = (factoriesMsg.factories as FactoryMsgShape[])[0];
  const robotCycleBefore = factory.production.find((p) => p.unitTypeKey === "robot")!;
  expect(robotCycleBefore.progressFraction).toBeLessThan(0.1); // just started

  await new Promise((r) => setTimeout(r, 300)); // ~0.3 real s = ~30ms game-time at scale 0.1 — negligible progress

  await closeAndWait(creator);
  await first.stop();

  const reopened = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(reopened);
  const resumedCreator = await connect(reopened.baseUrl, creatorToken);
  const resumedFactoriesMsg = await waitFor(resumedCreator, (m) => m.type === "factories" && (m.lobbyId as string) === lobbyId);
  const resumedFactory = (resumedFactoriesMsg.factories as FactoryMsgShape[])[0];
  const robotCycleResumed = resumedFactory.production.find((p) => p.unitTypeKey === "robot")!;
  expect(robotCycleResumed.progressFraction, "progress must have continued across the restart, not reset to 0").toBeGreaterThan(0);
  expect(robotCycleResumed.progressFraction, "robot's 120,000ms (2min) design duration at 0.1x scale is a 20 real-minute cycle — nowhere near complete yet").toBeLessThan(0.5);

  await closeAndWait(resumedCreator);
}, 20_000);
