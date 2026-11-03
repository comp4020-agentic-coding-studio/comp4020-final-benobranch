// Checks ANU-013's minimal occupancy primitive: placeUnit/moveUnit messages
// and the occupancy broadcast, with the placeholder "any real suburb"
// eligibility ANU-014 later replaces with real adjacency/flight rules.
import { readFileSync } from "node:fs";
import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");

const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as {
  suburbs: { sal_code: string }[];
};
const REAL_SAL_CODE = mapData.suburbs[0].sal_code;
const ANOTHER_REAL_SAL_CODE = mapData.suburbs[3].sal_code;

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

async function createStartedLobby(name: string): Promise<{ creator: Client; lobbyId: string }> {
  const creator = await connect();
  send(creator, { type: "createLobby", name, capacity: 4, callsign: "occupant" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === name);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  return { creator, lobbyId };
}

it("places a unit in a real suburb and broadcasts the resulting occupancy", async () => {
  const { creator } = await createStartedLobby(`occupancy-place-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: REAL_SAL_CODE, unitTypeKey: "drone" });
  const occ = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === REAL_SAL_CODE));
  const unit = (occ.units as { sal_code: string; unitTypeKey: string; health: number }[]).find((u) => u.sal_code === REAL_SAL_CODE)!;
  expect(unit.unitTypeKey).toBe("drone");
  expect(unit.health).toBeGreaterThan(0);

  await closeAndWait(creator);
});

it("rejects placing a unit in a suburb that doesn't exist", async () => {
  const { creator } = await createStartedLobby(`occupancy-reject-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: "99999", unitTypeKey: "drone" });
  const error = await waitFor(creator, (m) => m.type === "error");
  expect((error.message as string).toLowerCase()).toContain("unknown-suburb");

  await closeAndWait(creator);
});

it("moves a placed unit to a different real suburb", async () => {
  const { creator } = await createStartedLobby(`occupancy-move-${Date.now()}`);

  send(creator, { type: "placeUnit", sal_code: REAL_SAL_CODE, unitTypeKey: "robot" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === REAL_SAL_CODE));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === REAL_SAL_CODE)!.id;

  send(creator, { type: "moveUnit", unitId, sal_code: ANOTHER_REAL_SAL_CODE });
  const moved = await waitFor(
    creator,
    (m) =>
      m.type === "occupancy" &&
      (m.units as { id: string; sal_code: string }[]).some((u) => u.id === unitId && u.sal_code === ANOTHER_REAL_SAL_CODE),
  );
  const occupantIds = (moved.units as { id: string; sal_code: string }[]).filter((u) => u.sal_code === REAL_SAL_CODE);
  expect(occupantIds.find((u) => u.id === unitId), "the unit should no longer occupy its original suburb").toBeUndefined();

  await closeAndWait(creator);
});

it("sends current occupancy on reconnect, not just on the next change", async () => {
  const creatorForToken = await connect();
  const token = (creatorForToken.messages.find((m) => m.type === "welcome")!.token) as string;
  send(creatorForToken, { type: "createLobby", name: `occupancy-reconnect-${Date.now()}`, capacity: 4, callsign: "reconnect-occupant" });
  const created = await waitFor(creatorForToken, (m) => m.type === "lobbyState" && (m.lobby as { members: unknown[] }).members.length >= 1);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;
  send(creatorForToken, { type: "startLobby" });
  await waitFor(creatorForToken, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  send(creatorForToken, { type: "placeUnit", sal_code: REAL_SAL_CODE, unitTypeKey: "drone" });
  await waitFor(creatorForToken, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === REAL_SAL_CODE));
  await closeAndWait(creatorForToken);

  const reconnected = await connect(token);
  const occ = await waitFor(reconnected, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === REAL_SAL_CODE));
  expect((occ.units as { sal_code: string }[]).some((u) => u.sal_code === REAL_SAL_CODE)).toBe(true);

  await closeAndWait(reconnected);
});
