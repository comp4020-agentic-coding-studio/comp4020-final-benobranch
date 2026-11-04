// Checks ANU-019's time-gated skill-tree research survives a real process
// restart mid-research with correctly scaled elapsed progress (not reset or
// lost) — same style as spec/territory.test.ts's and
// spec/factories-restart.test.ts's restart tests. A research's
// skill_research.started_at is a stored timestamp (ADR 0001), never an
// armed timer, so it must still read the right progress after the process
// that started it is gone. Spawns its own server (spec/global-setup.ts's
// APP_URL server can't be restarted from inside a test) against a scratch
// port/DATA_DIR.
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";

const dataDir = mkdtempSync(join(tmpdir(), "anu019-skill-tree-restart-"));
const port = 8106;

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

interface SkillTreeMsgShape {
  unlockedNodeIds: string[];
  researching: { nodeId: string; progressFraction: number } | null;
}

it("skill-tree research in progress survives a real process restart mid-research, with correctly scaled elapsed progress, not reset or lost", async () => {
  // A LOW scale (better-fabs' 30,000ms/30s design duration stretched even
  // further in real time) ensures the research genuinely can't finish
  // during the brief restart window — same reasoning
  // spec/factories-restart.test.ts documents for its own scale choice.
  const SCALE = 0.1;
  const first = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(first);

  const lobbyName = `skill-restart-${Date.now()}`;
  const creator = await connect(first.baseUrl);
  const welcome = creator.messages.find((m) => m.type === "welcome")!;
  const creatorToken = welcome.token as string;
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "skill-creator" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  send(creator, { type: "startResearch", nodeId: "better-fabs" });
  const skillTreeMsg = await waitFor(creator, (m) => m.type === "skillTree" && (m.researching as { nodeId: string } | null)?.nodeId === "better-fabs");
  const researchBefore = (skillTreeMsg as unknown as SkillTreeMsgShape).researching!;
  expect(researchBefore.progressFraction).toBeLessThan(0.1); // just started

  await new Promise((r) => setTimeout(r, 300)); // ~0.3 real s = ~30ms game-time at scale 0.1 — negligible progress

  await closeAndWait(creator);
  await first.stop();

  const reopened = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(reopened);
  const resumedCreator = await connect(reopened.baseUrl, creatorToken);
  const resumedSkillTreeMsg = await waitFor(resumedCreator, (m) => m.type === "skillTree");
  const resumed = (resumedSkillTreeMsg as unknown as SkillTreeMsgShape).researching;
  expect(resumed, "research must still be in progress after the restart, not lost").not.toBeNull();
  expect(resumed!.nodeId).toBe("better-fabs");
  expect(resumed!.progressFraction, "progress must have continued across the restart, not reset to 0").toBeGreaterThan(0);
  expect(resumed!.progressFraction, "better-fabs' 30,000ms (30s) design duration at 0.1x scale is a 5-real-minute research — nowhere near complete yet").toBeLessThan(0.5);

  await closeAndWait(resumedCreator);
}, 20_000);
