// Checks ANU-042's setAutoFortifyMode message end-to-end over the real
// WebSocket protocol — the redistribution logic itself is covered directly
// against server/auto-fortify.ts in spec/auto-fortify.test.ts, but nothing
// there exercises the parser branch, the index.ts handler, persistence
// across a reconnect, or a malformed payload. Same connect/send/waitFor
// pattern as spec/skill-tree-protocol.test.ts.
import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");

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

async function createLobby(name: string): Promise<{ creator: Client; lobbyId: string; token: string }> {
  const creator = await connect();
  const token = creator.messages.find((m) => m.type === "welcome")!.token as string;
  send(creator, { type: "createLobby", name, capacity: 4, callsign: "fortifier" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === name);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  return { creator, lobbyId, token };
}

it("defaults to 'off': a fresh hello's welcome/economy carries no stale mode and a just-joined lobby reports 'off' once an action triggers economy", async () => {
  const { creator } = await createLobby(`af-default-${Date.now()}`);

  send(creator, { type: "startLobby" });
  const economy = await waitFor(creator, (m) => m.type === "economy");
  expect(economy.autoFortifyMode).toBe("off");

  await closeAndWait(creator);
});

it("setAutoFortifyMode('balance') is accepted and reflected back on the very next economy message", async () => {
  const { creator } = await createLobby(`af-set-${Date.now()}`);
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "economy");

  creator.messages.length = 0;
  send(creator, { type: "setAutoFortifyMode", mode: "balance" });
  const economy = await waitFor(creator, (m) => m.type === "economy");
  expect(economy.autoFortifyMode).toBe("balance");

  await closeAndWait(creator);
});

it("rejects an unknown mode value with a parse error that closes the connection, same as any other malformed message", async () => {
  const { creator } = await createLobby(`af-bad-${Date.now()}`);
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "economy");

  send(creator, { type: "setAutoFortifyMode", mode: "not-a-real-mode" });
  await new Promise((resolve) => creator.ws.once("close", resolve));
  expect(creator.ws.readyState).toBe(creator.ws.CLOSED);
});

it("persists the chosen mode across a reconnect (same resumed token)", async () => {
  const { creator, token } = await createLobby(`af-persist-${Date.now()}`);
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "economy");
  send(creator, { type: "setAutoFortifyMode", mode: "border" });
  await waitFor(creator, (m) => m.type === "economy" && m.autoFortifyMode === "border");
  await closeAndWait(creator);

  // Reconnecting re-sends occupancy/factories/captures/economy for an
  // already-lobbied player as part of 'welcome' handling (server/index.ts's
  // `hello` branch) — economy specifically carries autoFortifyMode.
  const resumed = await connect(token);
  const economy = await waitFor(resumed, (m) => m.type === "economy");
  expect(economy.autoFortifyMode).toBe("border");

  await closeAndWait(resumed);
});
