// Checks ANU-016's skill tree (redesigned by ANU-019 into time-gated
// research) end-to-end over the real WebSocket protocol — the store-level
// logic is covered directly against server/skill-tree.ts in
// spec/skill-tree.test.ts, but nothing exercises the parser branch, the
// index.ts handler, or the resulting broadcast itself. ANU-013's Resolution
// records a process-crashing bug that slipped through exactly this kind of
// gap (a store-level-only test suite that never sent a real message over
// the wire) — this file is what closes that gap for this issue's own
// message type. Same connect/send/waitFor pattern as spec/occupancy.test.ts.
//
// Unlike ANU-016's original spend-based purchaseNode, starting research
// never requires funding a balance first — there's nothing to fund (TFLOPS
// is a live speed multiplier, not spent — server/tflops.ts) — so this file
// can now drive a real success-path startResearch over the wire, which
// ANU-016's own Resolution noted was impossible under the old design.
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

async function createStartedLobby(name: string): Promise<{ creator: Client; lobbyId: string; token: string }> {
  const creator = await connect();
  const token = creator.messages.find((m) => m.type === "welcome")!.token as string;
  send(creator, { type: "createLobby", name, capacity: 4, callsign: "skiller" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === name);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  return { creator, lobbyId, token };
}

// Lobby names must stay within protocol.ts's MAX_NAME_LENGTH (40) — a
// Date.now() suffix is 13 digits, so each prefix below is kept short enough
// that prefix + suffix never exceeds that (a too-long name throws inside
// parseClientMessage, which closes the socket with no 'error' message sent,
// hanging every subsequent waitFor rather than failing with a clear cause).
it("starting research on a root node succeeds over the wire and broadcasts a skillTree message with researching set", async () => {
  const { creator } = await createStartedLobby(`st-start-${Date.now()}`);

  send(creator, { type: "startResearch", nodeId: "better-fabs" });
  const skillTreeMsg = await waitFor(creator, (m) => m.type === "skillTree" && (m.researching as { nodeId: string } | null)?.nodeId === "better-fabs");
  expect(skillTreeMsg.unlockedNodeIds).toEqual([]); // not unlocked yet — research just started
  expect((skillTreeMsg.researching as { progressFraction: number }).progressFraction).toBeGreaterThanOrEqual(0);

  await closeAndWait(creator);
});

it("rejects startResearch for an unknown node id, over the wire, without closing the connection", async () => {
  const { creator } = await createStartedLobby(`st-unknown-${Date.now()}`);

  send(creator, { type: "startResearch", nodeId: "not-a-real-node" });
  const error = await waitFor(creator, (m) => m.type === "error");
  expect((error.message as string).toLowerCase()).toContain("unknown-node");
  expect(creator.ws.readyState, "the connection must survive a rejected startResearch").toBe(creator.ws.OPEN);

  await closeAndWait(creator);
});

it("rejects a second startResearch while one is already in progress, over the wire", async () => {
  const { creator } = await createStartedLobby(`st-busy-${Date.now()}`);

  send(creator, { type: "startResearch", nodeId: "better-fabs" });
  await waitFor(creator, (m) => m.type === "skillTree" && (m.researching as { nodeId: string } | null)?.nodeId === "better-fabs");

  send(creator, { type: "startResearch", nodeId: "lean-production" });
  const error = await waitFor(creator, (m) => m.type === "error");
  expect((error.message as string).toLowerCase()).toContain("already-researching");

  await closeAndWait(creator);
});

it("sends a fresh skillTree message (empty unlocked set, nothing researching, tflops 0) on reconnect ('hello' with a resumed token) to a started lobby", async () => {
  // The skillTree send on 'hello' only fires for a RESUMED session (an
  // existing lobbyId already on record for this token) — same reasoning as
  // occupancy/factories' own "send current state on reconnect" sends in
  // index.ts. The first-ever 'hello' of createStartedLobby's connection
  // happens before any lobby exists, so this test has to reconnect with the
  // token afterward to exercise that branch, same pattern as
  // spec/occupancy.test.ts's "sends current occupancy on reconnect" test.
  const { creator, token } = await createStartedLobby(`st-hello-${Date.now()}`);
  await closeAndWait(creator);

  const reconnected = await connect(token);
  const skillTreeMsg = await waitFor(reconnected, (m) => m.type === "skillTree");
  expect(skillTreeMsg.unlockedNodeIds).toEqual([]);
  expect(skillTreeMsg.researching).toBeNull();
  expect(skillTreeMsg.tflops).toBe(0); // no data center held
  expect(skillTreeMsg.speedMultiplier).toBe(1); // ANU-031: server/skill-tree.ts's speedMultiplier(0) === 1

  await closeAndWait(reconnected);
});

it("a closing-socket message with a malformed startResearch payload is rejected at parse time, not silently ignored", async () => {
  const creator = await connect();
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    creator.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  creator.ws.send(JSON.stringify({ type: "startResearch" })); // missing required 'nodeId'
  const { code } = await closed;
  expect(code).toBe(1008); // same policy-violation close code every other malformed message uses
});
