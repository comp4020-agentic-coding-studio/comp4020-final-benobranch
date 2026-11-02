// Checks the "persists" brief requirement directly: data written before a
// restart is still there after one. spec/global-setup.ts's APP_URL server
// can't be restarted from inside a test, so this spawns its own server
// against a scratch port and a temp DATA_DIR (docs/git-workflow.md rule 6),
// kills it, respawns it against the same DATA_DIR, and reads the data back.
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";
import WebSocket from "ws";

const dataDir = mkdtempSync(join(tmpdir(), "anu008-persist-"));
const port = 8101;

const servers: SpawnedServer[] = [];
const dataDirs: string[] = [dataDir];
afterAll(async () => {
  for (const server of servers) await server.stop();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

// `hello` auto-joins 'default' and the server broadcasts THAT lobby's state
// right after `welcome`, so "the next message after I send X" is not safe to
// assume is X's result — it races with that broadcast. Collecting all
// messages and matching by predicate (as realtime.test.ts does) avoids it.
function connect(baseUrl: string, name: string, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name, token })));
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

it("keeps a lobby's state across a real process restart", async () => {
  const first = await spawnServer({ port, dataDir });
  servers.push(first);

  // A fresh, uniquely named lobby, not 'default' — matched by name below so
  // the assertion can't accidentally pick up default's own broadcasts.
  const lobbyName = `restart-lobby-${Date.now()}`;
  const creator = await connect(first.baseUrl, "restart-test");
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4 });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  send(creator, { type: "bump" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; count: number }).lobbyId === lobbyId && (m.lobby as { count: number }).count === 1);
  send(creator, { type: "bump" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; count: number }).lobbyId === lobbyId && (m.lobby as { count: number }).count === 2);

  await closeAndWait(creator);
  await first.stop();

  const second = await spawnServer({ port, dataDir });
  servers.push(second);

  const reader = await connect(second.baseUrl, "reader");
  const readerWelcome = reader.messages.find((m) => m.type === "welcome")!;

  send(reader, { type: "joinLobby", lobbyId });
  const joined = await waitFor(reader, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);
  await closeAndWait(reader);

  expect((readerWelcome.lobby as { lobbyId: string }).lobbyId, "a fresh identity still lands in the default lobby").toBe(
    "default",
  );
  expect((joined.lobby as { count: number }).count, "the lobby's counter should have survived the restart").toBe(2);
});

it("resumes the same playerId and lobby via token across a restart", async () => {
  const tokenTestDataDir = mkdtempSync(join(tmpdir(), "anu008-token-"));
  dataDirs.push(tokenTestDataDir);
  const first = await spawnServer({ port: port + 1, dataDir: tokenTestDataDir });
  servers.push(first);

  const lobbyName = `token-lobby-${Date.now()}`;
  const creator = await connect(first.baseUrl, "token-test");
  const welcome = creator.messages.find((m) => m.type === "welcome")!;
  const token = welcome.token as string;
  const playerId = welcome.playerId as string;

  send(creator, { type: "createLobby", name: lobbyName, capacity: 4 });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  await closeAndWait(creator);
  await first.stop();

  const second = await spawnServer({ port: port + 1, dataDir: tokenTestDataDir });
  servers.push(second);

  const resumed = await connect(second.baseUrl, "token-test", token);
  const resumedWelcome = resumed.messages.find((m) => m.type === "welcome")!;
  await closeAndWait(resumed);

  expect(resumedWelcome.playerId, "the same token should resume the same playerId").toBe(playerId);
  expect(
    (resumedWelcome.lobby as { lobbyId: string }).lobbyId,
    "the same token should resume the lobby that player was in",
  ).toBe(lobbyId);
});
