// Checks the "real-time" and "multi-user" brief requirements together: a
// change one session makes appears in every other open session *in the same
// lobby*, within ~1s. Uses 5 concurrent connections in one lobby, not just
// 2, since the project's target is 5+ players playing at once, not only the
// 2-browser marker minimum. A separate test checks lobby isolation: a
// change must NOT appear to a session in a different lobby.
//
// Each test creates its own lobby rather than using 'default' — vitest can
// run spec files in parallel against the shared APP_URL server, so sharing
// a lobby across tests (or files) would make assertions about member/count
// flaky depending on run order.
import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface Client {
  socket: WebSocket;
  messages: ServerMessage[];
}

function connect(name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    socket.on("error", reject);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "hello", name }));
      resolve({ socket, messages });
    });
  });
}

function send(client: Client, message: Record<string, unknown>): void {
  client.socket.send(JSON.stringify(message));
}

function waitFor(client: Client, predicate: (m: ServerMessage) => boolean, timeoutMs = 1500): Promise<ServerMessage> {
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

function lobbyStateMessages(client: Client, lobbyId: string): ServerMessage[] {
  return client.messages.filter(
    (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId,
  );
}

it("broadcasts one connection's action to several others in the same lobby within ~1s", async () => {
  const N = 5;
  const lobbyName = `realtime-test-${Date.now()}`;
  const creator = await connect("realtime-creator");
  send(creator, { type: "createLobby", name: lobbyName, capacity: N + 1 });
  // 'hello' auto-joins 'default' and broadcasts that lobbyState too (to every
  // socket in it, including the sender), so the first lobbyState a newly
  // connected client sees may be for 'default', not the lobby just created —
  // match on the lobby's name, not "first lobbyState seen", to avoid it.
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  const joiners = await Promise.all(
    Array.from({ length: N - 1 }, (_, i) => connect(`realtime-joiner-${i}`)),
  );
  for (const joiner of joiners) {
    send(joiner, { type: "joinLobby", lobbyId });
    await waitFor(joiner, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);
  }
  const clients = [creator, ...joiners];

  const before = clients.map((c) => lobbyStateMessages(c, lobbyId).length);

  send(creator, { type: "bump" });

  await new Promise((r) => setTimeout(r, 1000));

  for (let i = 0; i < clients.length; i++) {
    const after = lobbyStateMessages(clients[i], lobbyId).length;
    expect(after, `connection ${i} should have received a new lobbyState broadcast`).toBeGreaterThan(before[i]);
  }

  const counts = new Set(clients.map((c) => (lobbyStateMessages(c, lobbyId).at(-1)!.lobby as { count: number }).count));
  expect(counts.size, "every connection in the lobby should agree on the resulting count").toBe(1);

  for (const c of clients) c.socket.close();
});

it("does not broadcast a lobby's state to a connection in a different lobby", async () => {
  const lobbyAName = `isolation-a-${Date.now()}`;
  const lobbyBName = `isolation-b-${Date.now()}`;

  const inLobbyA = await connect("isolation-a");
  send(inLobbyA, { type: "createLobby", name: lobbyAName, capacity: 4 });
  const aState = await waitFor(inLobbyA, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyAName);
  const lobbyAId = (aState.lobby as { lobbyId: string }).lobbyId;

  const inLobbyB = await connect("isolation-b");
  send(inLobbyB, { type: "createLobby", name: lobbyBName, capacity: 4 });
  await waitFor(inLobbyB, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyBName);

  send(inLobbyA, { type: "bump" });
  await new Promise((r) => setTimeout(r, 500));

  const bSawLobbyA = lobbyStateMessages(inLobbyB, lobbyAId).length;
  expect(bSawLobbyA, "a connection in lobby B must not receive lobby A's state").toBe(0);

  inLobbyA.socket.close();
  inLobbyB.socket.close();
});

it("updates a watching connection's lobby list when a new lobby is created", async () => {
  const watcher = await connect("list-watcher");
  send(watcher, { type: "watchLobbies" });
  await waitFor(watcher, (m) => m.type === "lobbyList");
  const before = watcher.messages.filter((m) => m.type === "lobbyList").length;

  const creatorName = `list-test-${Date.now()}`;
  const creator = await connect("list-creator");
  send(creator, { type: "createLobby", name: creatorName, capacity: 4 });
  await waitFor(creator, (m) => m.type === "lobbyState");

  const listUpdate = await waitFor(
    watcher,
    (m) =>
      m.type === "lobbyList" &&
      // Default's own member/online count changes on every hello/close too,
      // so match specifically on the new lobby's name appearing in the list.
      (m.lobbies as { name: string }[]).some((l) => l.name === creatorName),
  );
  expect(
    watcher.messages.filter((m) => m.type === "lobbyList").length,
    "the watcher should have received a new lobbyList broadcast",
  ).toBeGreaterThan(before);
  expect((listUpdate.lobbies as { name: string }[]).some((l) => l.name === creatorName)).toBe(true);

  watcher.socket.close();
  creator.socket.close();
});
