// Checks ANU-015's production queue survives a real process restart
// mid-build with correctly scaled elapsed progress — same style as
// spec/territory.test.ts's and spec/persistence.test.ts's restart tests.
// Spawns its own server (spec/global-setup.ts's APP_URL server can't be
// restarted from inside a test) against a scratch port/DATA_DIR.
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";
import { openStore } from "../server/store.ts";

const dataDir = mkdtempSync(join(tmpdir(), "anu015-factory-restart-"));
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

it("a production queue survives a real process restart mid-build with correct elapsed progress, not reset or lost", async () => {
  // A LOW scale (robot's 3000ms design duration stretched to 30 real
  // seconds) ensures the build genuinely can't finish during the brief
  // restart window — same reasoning spec/territory.test.ts's restart test
  // documents for its own scale choice, just in the opposite direction
  // (that test speeds time up; this one needs it slowed down so a build in
  // progress stays in progress across the restart).
  const SCALE = 0.1;
  const first = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(first);

  const lobbyName = `factory-restart-${Date.now()}`;
  const creator = await connect(first.baseUrl);
  const welcome = creator.messages.find((m) => m.type === "welcome")!;
  const creatorToken = welcome.token as string;
  const creatorPlayerId = welcome.playerId as string;
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "factory-creator" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  const factoriesMsg = await waitFor(creator, (m) => m.type === "factories" && (m.lobbyId as string) === lobbyId);
  const factoryId = (factoriesMsg.factories as { id: string }[])[0].id;

  // No protocol message grants scrap directly (it's only earned via kills —
  // see server/units.ts) — stop the server and credit it via a direct
  // store connection against the same DATA_DIR file, same boundary
  // spec/units.test.ts/spec/factories.test.ts use for store-level setup,
  // just against the persisted file instead of :memory:.
  await closeAndWait(creator);
  await first.stop();
  const setupStore = openStore(`${dataDir}/game.db`);
  setupStore.db.prepare("UPDATE lobby_members SET scrap = scrap + ? WHERE lobby_id = ? AND player_id = ?").run(10, lobbyId, creatorPlayerId);
  setupStore.close();

  const reopened = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(reopened);
  const resumedCreator = await connect(reopened.baseUrl, creatorToken);

  send(resumedCreator, { type: "queueUnit", factoryId, unitTypeKey: "robot" });
  const queued = await waitFor(
    resumedCreator,
    (m) => m.type === "factories" && (m.factories as { id: string; queuedUnitTypeKey: string | null }[]).find((f) => f.id === factoryId)?.queuedUnitTypeKey === "robot",
  );
  const queueStartedBefore = (queued.factories as { id: string; queuedUnitTypeKey: string | null }[]).find((f) => f.id === factoryId)!;
  expect(queueStartedBefore.queuedUnitTypeKey).toBe("robot");

  await new Promise((r) => setTimeout(r, 300)); // ~0.3 real s = ~30ms game-time at scale 0.1 — negligible progress

  await closeAndWait(resumedCreator);
  await reopened.stop();

  const second = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(second);

  const reader = await connect(second.baseUrl, creatorToken);
  const resumedFactories = await waitFor(reader, (m) => m.type === "factories" && (m.lobbyId as string) === lobbyId);
  const resumedFactory = (resumedFactories.factories as { id: string; queuedUnitTypeKey: string | null; queueProgressFraction: number | null }[]).find((f) => f.id === factoryId)!;

  expect(resumedFactory.queuedUnitTypeKey, "the queued build must survive the restart, not be reset or lost").toBe("robot");
  expect(resumedFactory.queueProgressFraction, "progress should exist but be small — robot's 3000ms design duration at 0.1x scale is a 30 real-second build").not.toBeNull();
  expect(resumedFactory.queueProgressFraction!).toBeLessThan(0.5);

  await closeAndWait(reader);
}, 20_000);
