// Checks the "real-time" and "multi-user" brief requirements together: a
// change one session makes appears in every other open session. Uses 5
// concurrent connections, not just 2, since the project's target is 5+
// players playing at once, not only the 2-browser marker minimum.
import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");
const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

function connect(name: string): Promise<{ socket: WebSocket; messages: ServerMessage[] }> {
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

it("broadcasts one connection's action to several others within ~1s", async () => {
  const N = 5;
  const clients = await Promise.all(
    Array.from({ length: N }, (_, i) => connect(`realtime-test-${i}`)),
  );

  // let 'welcome'/'presence' settle before taking the baseline
  await new Promise((r) => setTimeout(r, 200));
  const before = clients.map((c) => c.messages.filter((m) => m.type === "counter").length);

  clients[0].socket.send(JSON.stringify({ type: "bump" }));

  await new Promise((r) => setTimeout(r, 1000));

  for (let i = 0; i < N; i++) {
    const counterMsgs = clients[i].messages.filter((m) => m.type === "counter");
    expect(
      counterMsgs.length,
      `connection ${i} should have received exactly one new 'counter' broadcast`,
    ).toBe(before[i] + 1);
  }

  const counts = new Set(
    clients.map((c) => c.messages.filter((m) => m.type === "counter").at(-1)?.count),
  );
  expect(counts.size, "every connection should agree on the resulting count").toBe(1);

  for (const { socket } of clients) socket.close();
});
