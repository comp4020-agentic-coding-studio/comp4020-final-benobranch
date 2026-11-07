// Checks ANU-017's capture state machine (server/territory.ts's
// settleCaptures): uncontested accrual, pause-on-contest, resume-without-
// loss, reset-on-contester-takeover, completion-transfers-ownership, a
// restart mid-capture resuming correct elapsed/paused state, and
// captureSpeedMultiplier actually changing the accrual rate. Exercised
// directly against server/territory.ts + a real in-memory SQLite connection
// (same pattern as spec/units.test.ts/spec/factories.test.ts) since none of
// this has a dedicated request/response message — settleCaptures runs as a
// side effect of placeUnit/moveUnit/attackSuburb, which is covered
// separately below over the real WebSocket protocol.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { openStore } from "../server/store.ts";
import { createTerritory, CAPTURE_DURATION_MS } from "../server/territory.ts";
import { createUnits } from "../server/units.ts";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";
import WebSocket from "ws";

interface MapFixture {
  suburbs: { sal_code: string; name: string }[];
  spawn_table_by_lobby_size: Record<string, { spawns: string[] }>;
}
const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as MapFixture;
const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));
const SPAWN_SAL_CODE = nameToSalCode.get(mapData.spawn_table_by_lobby_size["4"].spawns[0])!;
// A suburb far from any spawn ring — used as a neutral contested zone so
// ownership-based spawn assignment never interferes with these tests.
const NEUTRAL_SAL_CODE = mapData.suburbs.find((s) => !Object.values(mapData.spawn_table_by_lobby_size).some((e) => e.spawns.includes(s.name)))!.sal_code;

function setup() {
  const store = openStore(":memory:");
  const territory = createTerritory(store.db);
  const units = createUnits(store.db);
  const { playerId: owner } = store.resolvePlayer(undefined);
  const lobby = store.createLobby("capture-test", 4, owner, "owner");
  store.startLobby(lobby.lobbyId);
  territory.assignSpawnOwnership(lobby.lobbyId, [owner]);
  return { store, territory, units, lobbyId: lobby.lobbyId, owner };
}

/** Backdates a suburb's capture_started_at so elapsedMs reports the given fraction of CAPTURE_DURATION_MS already elapsed — avoids a real sleep. */
function backdateCapture(store: ReturnType<typeof openStore>, lobbyId: string, salCode: string, elapsedMs: number): void {
  const pastIso = new Date(Date.now() - elapsedMs).toISOString();
  store.db.prepare("UPDATE suburb_ownership SET capture_started_at = ? WHERE lobby_id = ? AND sal_code = ?").run(pastIso, lobbyId, salCode);
}

it("an uncontested capture on a neutral suburb accrues progress over time and reports no contesters", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");

  const first = territory.settleCaptures(lobbyId);
  expect(first.captures).toHaveLength(1);
  expect(first.captures[0]).toMatchObject({ sal_code: NEUTRAL_SAL_CODE, capturingPlayerId: owner, contestingPlayerIds: [] });
  expect(first.captures[0].progressFraction).toBeGreaterThanOrEqual(0);
  expect(first.transfers).toHaveLength(0);

  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.5);
  const halfway = territory.settleCaptures(lobbyId);
  expect(halfway.captures[0].progressFraction).toBeGreaterThan(0.4);
  expect(halfway.captures[0].progressFraction).toBeLessThan(0.6);

  store.close();
});

it("reaching 100% uncontested transfers ownership and clears the capture columns back to neutral", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  territory.settleCaptures(lobbyId);
  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 1.5); // well past completion

  const result = territory.settleCaptures(lobbyId);
  expect(result.transfers).toEqual([{ salCode: NEUTRAL_SAL_CODE, newOwnerPlayerId: owner }]);
  expect(result.captures, "a completed capture must not still report as in-progress").toHaveLength(0);
  expect(territory.getOwnership(lobbyId)[NEUTRAL_SAL_CODE]).toBe(owner);

  const row = store.db
    .prepare("SELECT capturing_player_id AS capturingPlayerId, capture_started_at AS captureStartedAt, capture_accumulated_ms AS captureAccumulatedMs FROM suburb_ownership WHERE lobby_id = ? AND sal_code = ?")
    .get(lobbyId, NEUTRAL_SAL_CODE) as { capturingPlayerId: string | null; captureStartedAt: string | null; captureAccumulatedMs: number };
  expect(row.capturingPlayerId).toBeNull();
  expect(row.captureStartedAt).toBeNull();
  expect(row.captureAccumulatedMs).toBe(0);

  store.close();
});

it("a competing player entering the zone pauses progress (freezes capture_accumulated_ms)", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  const { playerId: contester } = store.resolvePlayer(undefined);
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  territory.settleCaptures(lobbyId);
  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.3);

  const beforeContest = territory.settleCaptures(lobbyId);
  const frozenFraction = beforeContest.captures[0].progressFraction;
  expect(frozenFraction).toBeGreaterThan(0.2);
  expect(frozenFraction).toBeLessThan(0.4);

  units.placeUnit(lobbyId, contester, NEUTRAL_SAL_CODE, "drone");
  const contested = territory.settleCaptures(lobbyId);
  expect(contested.captures[0].contestingPlayerIds).toEqual([contester]);
  // Progress must not have advanced further despite more real time passing
  // before this settle call than the one above.
  expect(contested.captures[0].progressFraction).toBeCloseTo(frozenFraction, 2);

  // Still frozen even after a further real delay while contested.
  const stillContested = territory.settleCaptures(lobbyId);
  expect(stillContested.captures[0].progressFraction).toBeCloseTo(frozenFraction, 2);

  store.close();
});

it("the contester leaving resumes progress from the paused value, without loss", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  const { playerId: contester } = store.resolvePlayer(undefined);
  const attacker = units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  if (!attacker.ok) throw new Error("unreachable");
  territory.settleCaptures(lobbyId);
  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.3);
  territory.settleCaptures(lobbyId); // freezes at ~0.3

  const invader = units.placeUnit(lobbyId, contester, NEUTRAL_SAL_CODE, "drone");
  if (!invader.ok) throw new Error("unreachable");
  const paused = territory.settleCaptures(lobbyId);
  const pausedFraction = paused.captures[0].progressFraction;

  // Contester leaves.
  units.moveUnit(lobbyId, contester, invader.unit.id, SPAWN_SAL_CODE);
  const resumed = territory.settleCaptures(lobbyId);
  expect(resumed.captures[0].contestingPlayerIds).toEqual([]);
  expect(resumed.captures[0].capturingPlayerId).toBe(owner);
  // Must resume from the paused value, not reset or jump ahead.
  expect(resumed.captures[0].progressFraction).toBeGreaterThanOrEqual(pausedFraction - 0.02);
  expect(resumed.captures[0].progressFraction).toBeLessThan(pausedFraction + 0.1);

  store.close();
});

it("the contester's own units taking the zone resets the original capturer's progress to zero and restarts for the new capturer", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  const { playerId: contester } = store.resolvePlayer(undefined);
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  territory.settleCaptures(lobbyId);
  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.6);
  territory.settleCaptures(lobbyId); // owner at ~0.6 progress

  // The original capturer's unit is removed (captured/killed elsewhere) and
  // only the contester's unit remains — "the contester's own units take the
  // zone" (issues/ANU-017.md).
  store.db.prepare("DELETE FROM units WHERE lobby_id = ? AND sal_code = ? AND owner_player_id = ?").run(lobbyId, NEUTRAL_SAL_CODE, owner);
  units.placeUnit(lobbyId, contester, NEUTRAL_SAL_CODE, "drone");

  const result = territory.settleCaptures(lobbyId);
  expect(result.captures[0].capturingPlayerId).toBe(contester);
  expect(result.captures[0].progressFraction).toBeLessThan(0.05); // reset to ~0, not continuing from 0.6

  store.close();
});

it("a suburb contested by three or more players at once reports every non-capturer, non-owner occupant as a contester", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  const { playerId: contesterA } = store.resolvePlayer(undefined);
  const { playerId: contesterB } = store.resolvePlayer(undefined);
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  territory.settleCaptures(lobbyId);
  units.placeUnit(lobbyId, contesterA, NEUTRAL_SAL_CODE, "drone");
  units.placeUnit(lobbyId, contesterB, NEUTRAL_SAL_CODE, "drone");

  const result = territory.settleCaptures(lobbyId);
  expect(result.captures[0].capturingPlayerId).toBe(owner);
  expect(new Set(result.captures[0].contestingPlayerIds)).toEqual(new Set([contesterA, contesterB]));

  store.close();
});

it("capturing an enemy-owned suburb: the owner's own units are never counted as a contester of the invader's capture", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  const { playerId: invader } = store.resolvePlayer(undefined);
  // owner already owns SPAWN_SAL_CODE via assignSpawnOwnership; place a
  // defending unit there too, then have `invader` start capturing it.
  units.placeUnit(lobbyId, owner, SPAWN_SAL_CODE, "drone");
  units.placeUnit(lobbyId, invader, SPAWN_SAL_CODE, "drone");

  const result = territory.settleCaptures(lobbyId);
  expect(result.captures).toHaveLength(1);
  expect(result.captures[0]).toMatchObject({ sal_code: SPAWN_SAL_CODE, capturingPlayerId: invader, contestingPlayerIds: [] });
  expect(territory.getOwnership(lobbyId)[SPAWN_SAL_CODE], "ownership must not change until the capture completes").toBe(owner);

  store.close();
});

// ANU-044: reproduces the reported bug end-to-end -- two non-owning players
// both garrisoned in the same neutral suburb must actually fight (via
// server/units.ts's settleGarrisonCombat, called alongside settleCaptures
// the same way server/index.ts's settleArrivals wrapper now does), not sit
// in a frozen "contested" stand-off that silently resolves to one side
// capturing uncontested once the other quietly leaves (the alternating-
// capture loop the user described). territory.ts's own contest-freeze (the
// test above this one) is correct and unchanged -- this test proves the
// OTHER half of the fix: the units.ts side that actually destroys a
// garrison so the contest naturally ends instead of looping forever.
it("two non-owning players' garrisons in the same neutral suburb fight (not freeze forever) -- the contest resolves once one garrison is destroyed", () => {
  const { store, territory, lobbyId, owner } = setup();
  const { playerId: p1 } = store.resolvePlayer(undefined);
  const { playerId: p2 } = store.resolvePlayer(undefined);
  // rng() = 0.5 -> deterministic mid-range damage roll every hit.
  const units = createUnits(store.db, () => 0.5);
  units.placeUnit(lobbyId, p1, NEUTRAL_SAL_CODE, "robot");
  units.placeUnit(lobbyId, p2, NEUTRAL_SAL_CODE, "robot");

  // First settle: territory.ts correctly reports this as contested (2
  // capturers present) and freezes progress -- this part already worked.
  const firstSettle = territory.settleCaptures(lobbyId);
  expect(firstSettle.captures[0].contestingPlayerIds.length).toBeGreaterThan(0);
  expect(firstSettle.transfers).toHaveLength(0);

  // Run the actual fix (settleGarrisonCombat) alongside settleCaptures,
  // same pairing server/index.ts's settleArrivals wrapper now does, until
  // one garrison is wiped out.
  let ticks = 0;
  for (; ticks < 10; ticks++) {
    const outcomes = units.settleGarrisonCombat(lobbyId);
    if (outcomes.length === 0) break;
    territory.settleCaptures(lobbyId);
    const remaining = units.getOccupancy(lobbyId).filter((u) => u.sal_code === NEUTRAL_SAL_CODE);
    if (new Set(remaining.map((u) => u.ownerPlayerId)).size < 2) break;
  }

  const remaining = units.getOccupancy(lobbyId).filter((u) => u.sal_code === NEUTRAL_SAL_CODE);
  const survivingOwners = new Set(remaining.map((u) => u.ownerPlayerId));
  expect(survivingOwners.size, "combat must actually resolve the contest down to one side, not leave both standing forever").toBe(1);

  // With only the survivor present, territory.ts now sees a SOLE capturer
  // and resumes uncontested accrual for them -- the correct end state
  // ("the survivor earns the zone"), not an alternation where the loser's
  // side would somehow also get to capture.
  const finalSettle = territory.settleCaptures(lobbyId);
  expect(finalSettle.captures[0].contestingPlayerIds).toEqual([]);
  expect([p1, p2]).toContain(finalSettle.captures[0].capturingPlayerId);
  expect(survivingOwners.has(finalSettle.captures[0].capturingPlayerId!)).toBe(true);

  store.close();
});

it("captureSpeedMultiplier changes the accrual rate — a 2x multiplier completes in half the design duration", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  store.perks.setPerkMultiplier(lobbyId, owner, "captureSpeedMultiplier", 2);
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  territory.settleCaptures(lobbyId);

  // Half the base design duration should already be enough to complete at 2x speed.
  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.6);
  const result = territory.settleCaptures(lobbyId);
  expect(result.transfers).toEqual([{ salCode: NEUTRAL_SAL_CODE, newOwnerPlayerId: owner }]);

  store.close();
});

it("captureSpeedMultiplier below 1 slows accrual — a 0.5x multiplier is not yet complete at the base design duration", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  store.perks.setPerkMultiplier(lobbyId, owner, "captureSpeedMultiplier", 0.5);
  units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  territory.settleCaptures(lobbyId);

  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.9);
  const result = territory.settleCaptures(lobbyId);
  expect(result.transfers).toHaveLength(0);
  expect(result.captures[0].progressFraction).toBeLessThan(0.5);

  store.close();
});

it("leaving a suburb with no contester present pauses (not resets) progress", () => {
  const { store, territory, units, lobbyId, owner } = setup();
  const placed = units.placeUnit(lobbyId, owner, NEUTRAL_SAL_CODE, "drone");
  if (!placed.ok) throw new Error("unreachable");
  territory.settleCaptures(lobbyId);
  backdateCapture(store, lobbyId, NEUTRAL_SAL_CODE, CAPTURE_DURATION_MS * 0.4);
  territory.settleCaptures(lobbyId); // freezes ~0.4

  units.moveUnit(lobbyId, owner, placed.unit.id, SPAWN_SAL_CODE); // capturer fully retreats
  const afterLeave = territory.settleCaptures(lobbyId);
  expect(afterLeave.captures[0].progressFraction).toBeGreaterThan(0.3);
  expect(afterLeave.captures[0].progressFraction).toBeLessThan(0.5);
  expect(afterLeave.captures[0].capturingPlayerId).toBe(owner);

  // Returning resumes without loss.
  units.moveUnit(lobbyId, owner, placed.unit.id, NEUTRAL_SAL_CODE);
  const afterReturn = territory.settleCaptures(lobbyId);
  expect(afterReturn.captures[0].progressFraction).toBeGreaterThanOrEqual(afterLeave.captures[0].progressFraction - 0.02);

  store.close();
});

// --- real process restart mid-capture, same style as spec/territory.test.ts / spec/factories-restart.test.ts --- //

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

const dataDir = mkdtempSync(join(tmpdir(), "anu017-capture-restart-"));
const port = 8107; // 8106 is spec/skill-tree-restart.test.ts (ANU-019)
const servers: SpawnedServer[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

it("a capture in progress survives a real process restart mid-capture with correct elapsed progress, not reset or lost", async () => {
  // A LOW scale stretches CAPTURE_DURATION_MS's design duration out in real
  // time, same reasoning spec/factories-restart.test.ts documents for its
  // own scale choice, so the capture genuinely can't finish during the
  // brief restart window.
  const SCALE = 0.05;
  const first = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(first);

  const lobbyName = `capture-restart-${Date.now()}`;
  const creator = await connect(first.baseUrl);
  const welcome = creator.messages.find((m) => m.type === "welcome")!;
  const creatorToken = welcome.token as string;
  send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "capture-creator" });
  const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
  const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

  send(creator, { type: "startLobby" });
  await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);

  send(creator, { type: "placeUnit", sal_code: NEUTRAL_SAL_CODE, unitTypeKey: "drone" });
  const captureMsg = await waitFor(creator, (m) => m.type === "captures" && (m.captures as { sal_code: string }[]).some((c) => c.sal_code === NEUTRAL_SAL_CODE));
  const progressBefore = (captureMsg.captures as { sal_code: string; progressFraction: number }[]).find((c) => c.sal_code === NEUTRAL_SAL_CODE)!.progressFraction;
  expect(progressBefore).toBeLessThan(0.1); // just started

  await closeAndWait(creator);
  await first.stop();

  const reopened = await spawnServer({ port, dataDir, gameTimeScale: SCALE });
  servers.push(reopened);
  const reader = await connect(reopened.baseUrl, creatorToken);

  const resumed = await waitFor(reader, (m) => m.type === "captures" && (m.captures as { sal_code: string }[]).some((c) => c.sal_code === NEUTRAL_SAL_CODE));
  const resumedCapture = (resumed.captures as { sal_code: string; capturingPlayerId: string; progressFraction: number }[]).find((c) => c.sal_code === NEUTRAL_SAL_CODE)!;
  expect(resumedCapture.capturingPlayerId, "the capture must survive the restart, not be reset or lost").toBe(welcome.playerId);
  expect(resumedCapture.progressFraction).toBeGreaterThanOrEqual(progressBefore);
  expect(resumedCapture.progressFraction).toBeLessThan(0.5); // not yet complete, at this slowed-down scale

  await closeAndWait(reader);
}, 20_000);
