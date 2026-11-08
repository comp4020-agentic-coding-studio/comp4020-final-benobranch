// Checks ANU-020's two protocol additions over the real WebSocket protocol:
// the global unitCatalog broadcast (real seeded stats, not placeholders),
// and the per-player economy broadcast (private — sent only to the acting
// player, never to a bystander in the same lobby). Same connect/send/
// waitFor helpers as spec/occupancy.test.ts/spec/combat.test.ts.
//
// ANU-038: the kill test below needs its own spawned, time-scaled server
// (spec/lib/spawn-server.ts), not the shared unscaled spec/global-setup.ts
// APP_URL server — moveUnits only dispatches now, and a kill isn't credited
// until the attacking unit's travel time actually elapses (same reasoning
// spec/combat.test.ts documents for its own dedicated server).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";
import { openStore } from "../server/store.ts";

interface MapFixture {
  suburbs: { idx: number; sal_code: string; name: string }[];
  edges: { a: number; b: number }[];
  spawn_table_by_lobby_size: Record<string, { spawns: string[] }>;
}

const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as MapFixture;
const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));
const idxToSalCode = new Map(mapData.suburbs.map((s) => [s.idx, s.sal_code]));

const adjacency = new Map<string, Set<string>>();
for (const edge of mapData.edges) {
  const a = idxToSalCode.get(edge.a)!;
  const b = idxToSalCode.get(edge.b)!;
  if (!adjacency.has(a)) adjacency.set(a, new Set());
  if (!adjacency.has(b)) adjacency.set(b, new Set());
  adjacency.get(a)!.add(b);
  adjacency.get(b)!.add(a);
}

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

// buildFactory needs the acting player to own a SECOND suburb (their spawn
// already has a factory from spawnFactories — "already-exists" otherwise),
// and no protocol message exists yet to capture one (ANU-017's capture
// state machine is still open) — so this one test spawns its own server
// (same pattern as spec/factories-restart.test.ts) to grant that ownership
// via a direct store connection against the same DATA_DIR file, rather than
// over the shared inject("baseUrl") server every other test in this file
// used before ANU-038.
const buildFactoryTestDataDir = mkdtempSync(join(tmpdir(), "anu022-economy-buildfactory-"));
const buildFactoryTestPort = 8105;
let buildFactoryTestServer: SpawnedServer | undefined;

const killTestDataDir = mkdtempSync(join(tmpdir(), "anu038-economy-kill-"));
const killTestPort = 8109; // 8108 is spec/combat.test.ts (ANU-038)
let killTestServer: SpawnedServer | undefined;

afterAll(async () => {
  await buildFactoryTestServer?.stop();
  rmSync(buildFactoryTestDataDir, { recursive: true, force: true });
  await killTestServer?.stop();
  rmSync(killTestDataDir, { recursive: true, force: true });
});

/**
 * No protocol message grants scrap directly — it's only earned via kills
 * (server/units.ts), and a kill needs a genuine enemy occupant: a moveUnits
 * order against a target with no OTHER player's unit present just moves the
 * attacker there ("undefended", issues/ANU-014.md's Resolution), so the
 * defending drone must belong to a second, separate player. Repeatedly
 * dispatches a fresh attacker (robot) at a freshly-placed defender
 * (scrap_value 2, owned by `defender`) at `targetSalCode`, waiting out each
 * attempt's travel time (the caller's GAME_TIME_SCALE makes this short),
 * until one lands as a kill, crediting the attacker's own unit (placed at
 * `spawnSalCode`) 2 scrap. Bounded well under the combat rng's variance so
 * this stays fast without needing an injectable rng over the wire
 * (spec/units.test.ts covers the rng itself directly, against
 * server/units.ts).
 */
async function earnScrapByKilling(
  attacker: Client,
  attackerSalCode: string,
  defender: Client,
  spawnSalCode: string,
  targetSalCode: string,
): Promise<number> {
  // ANU-043: a "hit" outcome that doesn't kill the defender now ADVANCES the
  // attacker into targetSalCode (it stays there, contesting it, rather than
  // retreating to spawnSalCode) — so after the first attempt, the next
  // dispatch's fromSalCode must track wherever the attacker actually ended
  // up, not always spawnSalCode. `currentSalCode` is both the attacker's
  // real current position (settled by settleArrivals before this function's
  // next moveUnits call reads it) and the "attack in place" source once the
  // attacker has already reached targetSalCode.
  let currentSalCode = attackerSalCode;
  for (let i = 0; i < 20; i++) {
    send(defender, { type: "placeUnit", sal_code: targetSalCode, unitTypeKey: "drone" });
    await waitFor(defender, (m) => m.type === "occupancy", 1000);
    send(attacker, { type: "moveUnits", fromSalCode: currentSalCode, toSalCode: targetSalCode, counts: { robot: 1 } });
    try {
      const economy = await waitFor(attacker, (m) => m.type === "economy", 1000);
      return economy.scrap as number;
    } catch {
      // Survived the hit — not yet a kill, no scrap credited. The attacker
      // advanced into targetSalCode (ANU-043), so every subsequent attempt
      // dispatches from there, attacking in place (a zero-distance order
      // resolves effectively instantly).
      currentSalCode = targetSalCode;
    }
  }
  throw new Error("attacker never landed a kill after 20 attempts");
}

// 🚧 REMOVED 2026-11-05: "hello yields a unitCatalog with the real seeded
// drone/robot stats, not placeholders" asserted robot health: 6, but
// server/units.ts's seedBaseUnitTypes now seeds 10 (commit 9a2b164, "updated
// robot health" — a bare, undocumented direct commit to main with no issue
// or ADR behind it). That also leaves issues/ANU-014.md's "flat 2x ratio
// robot-over-drone" design invariant stale against the current seed values.
// Deleted rather than fixed, per explicit instruction, to unblock shipping;
// whoever revisits unit balance should decide whether 10 is the real value
// (and update ANU-014's invariant) or revert to 6.

it("a kill via moveUnits sends economy to the attacker only, not to a bystander in the same lobby", async () => {
  // A high scale so a robot's design travel time (slower than a drone's,
  // server/units.ts) over this fixture's distance resolves within a real
  // second or two, matching earnScrapByKilling's per-attempt waitFor budget.
  killTestServer = await spawnServer({ port: killTestPort, dataDir: killTestDataDir, gameTimeScale: 500 });
  const baseUrl = killTestServer.baseUrl;

  const lobbyName = `economy-kill-${Date.now()}`;
  const attacker = await connect(baseUrl);
  send(attacker, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "attacker" });
  const created = await waitFor(attacker, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  const bystander = await connect(baseUrl);
  send(bystander, { type: "joinLobby", lobbyId, callsign: "bystander" });
  await waitFor(bystander, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);

  send(attacker, { type: "startLobby" });
  await waitFor(attacker, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  await waitFor(bystander, (m) => m.type === "lobbyState" && (m.lobby as { started: boolean }).started);

  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  const targetSalCode = [...adjacency.get(spawnSalCode)!][0];

  send(attacker, { type: "placeUnit", sal_code: spawnSalCode, unitTypeKey: "robot" });
  await waitFor(attacker, (m) => m.type === "occupancy" && (m.units as { sal_code: string; ownerPlayerId: string }[]).some((u) => u.sal_code === spawnSalCode));

  // Clear history before the kill-seeking loop: startLobby already sent
  // attacker an `economy` message (scrap: 0), which would otherwise satisfy
  // earnScrapByKilling's waitFor immediately on its first iteration,
  // regardless of whether that iteration's attack actually killed anything.
  attacker.messages.length = 0;
  bystander.messages.length = 0;
  await earnScrapByKilling(attacker, spawnSalCode, bystander, spawnSalCode, targetSalCode);

  // The bystander, in the same lobby, must NOT have received any economy
  // message at any point — it's private to the player it belongs to.
  expect(bystander.messages.some((m) => m.type === "economy")).toBe(false);

  await closeAndWait(attacker);
  await closeAndWait(bystander);
}, 20_000);

it("buildFactory triggers an economy update to the acting player reflecting the scrap deduction (ANU-022: this is scrap's only remaining spend, since units auto-produce free)", async () => {
  const first = await spawnServer({ port: buildFactoryTestPort, dataDir: buildFactoryTestDataDir });
  buildFactoryTestServer = first;

  const lobbyName = `economy-build-${Date.now()}`;
  const creator = await connect(first.baseUrl);
  const welcome = creator.messages.find((m) => m.type === "welcome")!;
  const creatorToken = welcome.token as string;
  const creatorPlayerId = welcome.playerId as string;
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "builder" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  // A second suburb the creator owns — their spawn already has a factory
  // from spawnFactories, so buildFactory there would fail "already-exists".
  // No protocol message exists yet to capture a suburb (ANU-017 is still
  // open), so grant it via a direct store connection against the same
  // DATA_DIR file, same store-level-setup boundary
  // spec/factories-restart.test.ts uses — the server is stopped first
  // (same reasoning that test documents: two live SQLite connections to the
  // same file, one of them a separate process, risk lock contention) and
  // respawned afterward.
  const secondSalCode = mapData.suburbs.find((s) => s.sal_code !== spawnSalCode)!.sal_code;
  await closeAndWait(creator);
  await first.stop();
  const setupStore = openStore(`${buildFactoryTestDataDir}/game.db`);
  setupStore.db
    .prepare(
      "INSERT INTO suburb_ownership (lobby_id, sal_code, owner_player_id) VALUES (?, ?, ?) ON CONFLICT(lobby_id, sal_code) DO UPDATE SET owner_player_id = excluded.owner_player_id",
    )
    .run(lobbyId, secondSalCode, creatorPlayerId);
  setupStore.db
    .prepare("UPDATE lobby_members SET scrap = scrap + 20 WHERE lobby_id = ? AND player_id = ?") // FACTORY_BUILD_COST_SCRAP
    .run(lobbyId, creatorPlayerId);
  setupStore.close();

  const reopened = await spawnServer({ port: buildFactoryTestPort, dataDir: buildFactoryTestDataDir });
  buildFactoryTestServer = reopened;
  const resumedCreator = await connect(reopened.baseUrl, creatorToken);

  resumedCreator.messages.length = 0;
  send(resumedCreator, { type: "buildFactory", sal_code: secondSalCode });
  const economyAfterBuild = await waitFor(resumedCreator, (m) => m.type === "economy");
  expect(economyAfterBuild.scrap).toBe(0); // FACTORY_BUILD_COST_SCRAP, server/factories.ts

  await closeAndWait(resumedCreator);
});
