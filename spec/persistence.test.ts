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

const dataDir = mkdtempSync(join(tmpdir(), "anu005-persist-"));
const port = 8101;

const servers: SpawnedServer[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function bumpOnce(baseUrl: string): Promise<void> {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", name: "restart-test" }));
  await new Promise((resolve) => ws.once("message", resolve)); // welcome
  ws.send(JSON.stringify({ type: "bump" }));
  await new Promise((resolve) => ws.once("message", resolve)); // counter
  ws.close();
  await new Promise((resolve) => ws.once("close", resolve));
}

it("keeps data across a real process restart", async () => {
  const first = await spawnServer({ port, dataDir });
  servers.push(first);

  await bumpOnce(first.baseUrl);
  await bumpOnce(first.baseUrl);

  await first.stop();

  const second = await spawnServer({ port, dataDir });
  servers.push(second);

  const ws = new WebSocket(`${second.baseUrl.replace(/^http/, "ws")}/ws`);
  const welcome = await new Promise<{ count: number }>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name: "reader" })));
    ws.once("message", (raw) => resolve(JSON.parse(raw.toString())));
  });
  ws.close();

  expect(welcome.count, "counter should have survived the restart").toBe(2);
});
