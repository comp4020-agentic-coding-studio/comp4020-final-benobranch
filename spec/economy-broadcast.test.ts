// Checks ANU-020's two protocol additions over the real WebSocket protocol:
// the global unitCatalog broadcast (real seeded stats, not placeholders),
// and the per-player economy broadcast (private — sent only to the acting
// player, never to a bystander in the same lobby). Same connect/send/
// waitFor helpers as spec/occupancy.test.ts/spec/combat.test.ts.
import { readFileSync } from "node:fs";
import { expect, inject, it } from "vitest";
import WebSocket from "ws";

const baseUrl = inject("baseUrl");

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

/**
 * No protocol message grants scrap directly — it's only earned via kills
 * (server/units.ts), and a kill needs a genuine enemy occupant: attackSuburb
 * against a target with no OTHER player's unit present just moves the
 * attacker there ("undefended", issues/ANU-014.md's Resolution), so the
 * defending drone must belong to a second, separate player. Repeatedly
 * attacks a freshly-placed defender (build_cost_scrap 2, owned by
 * `defender`) at `targetSalCode` until one lands as a kill, crediting the
 * attacker's own unit (placed at `spawnSalCode`) 2 scrap. Bounded well
 * under the combat rng's variance so this stays fast without needing an
 * injectable rng over the wire (spec/units.test.ts covers the rng itself
 * directly, against server/units.ts).
 */
async function earnScrapByKilling(
  attacker: Client,
  attackerUnitId: string,
  defender: Client,
  spawnSalCode: string,
  targetSalCode: string,
): Promise<number> {
  for (let i = 0; i < 20; i++) {
    send(defender, { type: "placeUnit", sal_code: targetSalCode, unitTypeKey: "drone" });
    await waitFor(defender, (m) => m.type === "occupancy", 300);
    send(attacker, { type: "attackSuburb", unitId: attackerUnitId, sal_code: targetSalCode });
    try {
      const economy = await waitFor(attacker, (m) => m.type === "economy", 300);
      return economy.scrap as number;
    } catch {
      // Survived the hit — not yet a kill, no scrap credited. A "hit"
      // outcome leaves the attacker's sal_code unchanged (server/units.ts
      // only advances it on "moved"/"kill"), so it's still at spawnSalCode
      // and the next iteration's placeUnit can retry against a fresh
      // defender with no repositioning needed.
    }
  }
  throw new Error("attacker never landed a kill after 20 attempts");
}

it("hello yields a unitCatalog with the real seeded drone/robot stats, not placeholders", async () => {
  const client = await connect();
  const catalog = await waitFor(client, (m) => m.type === "unitCatalog");
  const unitTypes = catalog.unitTypes as {
    key: string;
    health: number;
    damage: number;
    buildCostScrap: number;
    buildTimeMs: number;
    movementMode: string;
  }[];

  const drone = unitTypes.find((t) => t.key === "drone")!;
  const robot = unitTypes.find((t) => t.key === "robot")!;
  expect(drone).toBeDefined();
  expect(robot).toBeDefined();
  // server/units.ts's seedBaseUnitTypes — real values, not zeroed placeholders.
  expect(drone).toMatchObject({ health: 3, damage: 2, buildCostScrap: 2, buildTimeMs: 1500, movementMode: "fly" });
  expect(robot).toMatchObject({ health: 6, damage: 4, buildCostScrap: 4, buildTimeMs: 3000, movementMode: "ground" });

  await closeAndWait(client);
});

it("a kill via attackSuburb sends economy to the attacker only, not to a bystander in the same lobby", async () => {
  const lobbyName = `economy-kill-${Date.now()}`;
  const attacker = await connect();
  send(attacker, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "attacker" });
  const created = await waitFor(attacker, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  const bystander = await connect();
  send(bystander, { type: "joinLobby", lobbyId, callsign: "bystander" });
  await waitFor(bystander, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);

  send(attacker, { type: "startLobby" });
  await waitFor(attacker, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
  await waitFor(bystander, (m) => m.type === "lobbyState" && (m.lobby as { started: boolean }).started);

  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  const targetSalCode = [...adjacency.get(spawnSalCode)!][0];

  send(attacker, { type: "placeUnit", sal_code: spawnSalCode, unitTypeKey: "robot" });
  const placed = await waitFor(attacker, (m) => m.type === "occupancy" && (m.units as { sal_code: string; ownerPlayerId: string }[]).some((u) => u.sal_code === spawnSalCode));
  const attackerUnitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === spawnSalCode)!.id;

  // Clear history before the kill-seeking loop: startLobby already sent
  // attacker an `economy` message (scrap: 0), which would otherwise satisfy
  // earnScrapByKilling's waitFor immediately on its first iteration,
  // regardless of whether that iteration's attack actually killed anything.
  attacker.messages.length = 0;
  bystander.messages.length = 0;
  await earnScrapByKilling(attacker, attackerUnitId, bystander, spawnSalCode, targetSalCode);

  // The bystander, in the same lobby, must NOT have received any economy
  // message at any point — it's private to the player it belongs to.
  expect(bystander.messages.some((m) => m.type === "economy")).toBe(false);

  await closeAndWait(attacker);
  await closeAndWait(bystander);
});

it("queueUnit triggers an economy update to the acting player reflecting the scrap deduction", async () => {
  const lobbyName = `economy-queue-${Date.now()}`;
  const creator = await connect();
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "queuer" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  // A second player to own the defender a kill needs (attackSuburb against
  // a target with no OTHER player's unit present is just an undefended
  // "move" — see earnScrapByKilling's comment).
  const other = await connect();
  send(other, { type: "joinLobby", lobbyId, callsign: "target-owner" });
  await waitFor(other, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);

  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  const factoriesMsg = await waitFor(creator, (m) => m.type === "factories" && (m.lobbyId as string) === lobbyId);
  const factoryId = (factoriesMsg.factories as { id: string }[])[0].id;

  const spawnSalCode = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
  const targetSalCode = [...adjacency.get(spawnSalCode)!][0];
  send(creator, { type: "placeUnit", sal_code: spawnSalCode, unitTypeKey: "robot" });
  const placed = await waitFor(creator, (m) => m.type === "occupancy" && (m.units as { sal_code: string }[]).some((u) => u.sal_code === spawnSalCode));
  const unitId = (placed.units as { id: string; sal_code: string }[]).find((u) => u.sal_code === spawnSalCode)!.id;
  // Clear history before the kill-seeking loop — see the kill-privacy
  // test's identical comment for why (a stale economy:{scrap:0} from
  // startLobby would otherwise satisfy the first waitFor immediately).
  creator.messages.length = 0;
  const scrapAfterKill = await earnScrapByKilling(creator, unitId, other, spawnSalCode, targetSalCode);
  expect(scrapAfterKill).toBeGreaterThanOrEqual(2); // drone's build_cost_scrap — enough to afford a queue below

  creator.messages.length = 0;
  send(creator, { type: "queueUnit", factoryId, unitTypeKey: "drone" });
  const economyAfterQueue = await waitFor(creator, (m) => m.type === "economy");
  expect(economyAfterQueue.scrap).toBe(scrapAfterKill - 2); // drone build_cost_scrap, server/units.ts

  await closeAndWait(creator);
  await closeAndWait(other);
});
