// Checks a bug ANU-013 introduced and fixed before merging: lobby_members'
// INSERT OR REPLACE (the original "move to a different lobby" mechanism)
// was replaced with a plain INSERT for first-join that didn't account for
// a player who already belongs to a different lobby — `player_id` is still
// lobby_members' primary key, so that plain INSERT threw a UNIQUE
// constraint violation the moment an existing member of lobby A created or
// joined lobby B (the ordinary Server Browse flow), uncaught inside the ws
// message handler. Fixed with `INSERT ... ON CONFLICT(player_id) DO UPDATE`,
// which also resets economy/perk columns on a genuine lobby switch (a new
// game, not a continuation of the old one's).
import { expect, inject, it } from "vitest";
import { openStore } from "../server/store.ts";
import WebSocket from "ws";

it("switching from one lobby to another (createLobby while already a member elsewhere) does not throw", () => {
  const store = openStore(":memory:");
  const { playerId } = store.resolvePlayer(undefined);
  const lobbyA = store.createLobby("switch-a", 4, playerId, "switcher");

  expect(() => store.createLobby("switch-b", 4, playerId, "switcher")).not.toThrow();

  const lobbyB = store.listLobbies().find((l) => l.name === "switch-b")!;
  expect(store.getCurrentLobbyId(playerId), "the player should now be in lobby B, not A").toBe(lobbyB.lobbyId);
  expect(store.getLobbyMembers(lobbyA.lobbyId), "lobby A should have no members left").toHaveLength(0);

  store.close();
});

it("switching lobbies resets economy and perk state, not just lobby membership", () => {
  const store = openStore(":memory:");
  const { playerId } = store.resolvePlayer(undefined);
  const lobbyA = store.createLobby("switch-economy-a", 4, playerId, "switcher");
  store.perks.setPerkMultiplier(lobbyA.lobbyId, playerId, "scrapPerKillMultiplier", 3);

  const lobbyB = store.createLobby("switch-economy-b", 4, playerId, "switcher");
  const economy = store.getMemberEconomy(lobbyB.lobbyId, playerId)!;
  expect(economy.scrap).toBe(0);
  expect(store.perks.getPerkMultipliers(lobbyB.lobbyId, playerId).scrapPerKillMultiplier, "a fresh lobby membership should not carry over the old lobby's perk purchases").toBe(1);

  store.close();
});

it("reconnecting to the SAME lobby (joinLobby for an already-joined lobby) preserves color and economy", () => {
  const store = openStore(":memory:");
  const { playerId } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("reconnect-same", 4, playerId, "reconnector");
  store.perks.setPerkMultiplier(lobby.lobbyId, playerId, "scrapPerKillMultiplier", 3);
  const colorBefore = store.getMemberColor(lobby.lobbyId, playerId);

  const result = store.joinLobby(playerId, lobby.lobbyId, undefined);
  expect(result.ok).toBe(true);

  expect(store.getMemberColor(lobby.lobbyId, playerId), "a reconnect to the same lobby must not reassign color").toBe(colorBefore);
  expect(
    store.perks.getPerkMultipliers(lobby.lobbyId, playerId).scrapPerKillMultiplier,
    "a reconnect to the same lobby must not reset perk multipliers",
  ).toBe(3);

  store.close();
});

const baseUrl = inject("baseUrl");

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

function connectWs(): Promise<{ ws: WebSocket; messages: ServerMessage[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`);
    const messages: ServerMessage[] = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello" })));
    const client = { ws, messages };
    waitForWs(client, (m) => m.type === "welcome").then(() => resolve(client), reject);
  });
}

function waitForWs(
  client: { messages: ServerMessage[] },
  predicate: (m: ServerMessage) => boolean,
  timeoutMs = 2000,
): Promise<ServerMessage> {
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

it("over the real WebSocket protocol: creating lobby B while already in lobby A doesn't crash the server or the connection", async () => {
  const client = await connectWs();
  client.ws.send(JSON.stringify({ type: "createLobby", name: `ws-switch-a-${Date.now()}`, capacity: 4, callsign: "ws-switcher" }));
  await waitForWs(client, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name.startsWith("ws-switch-a"));

  client.ws.send(JSON.stringify({ type: "createLobby", name: `ws-switch-b-${Date.now()}`, capacity: 4, callsign: "ws-switcher" }));
  const stateB = await waitForWs(client, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name.startsWith("ws-switch-b"));
  expect((stateB.lobby as { members: { name: string }[] }).members.some((m) => m.name === "ws-switcher")).toBe(true);

  // The server must still be alive and answering after the switch.
  const health = await fetch(baseUrl);
  expect(health.status).toBe(200);

  client.ws.close();
});
