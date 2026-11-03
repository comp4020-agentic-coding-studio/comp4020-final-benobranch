// Checks issues/ANU-013.md's foundation pieces: unique per-lobby player
// colors disjoint from map.js's data-center marker colors, spawn suburbs
// auto-owned the moment a lobby starts, and the stored-timestamp rule
// (lobby startedAt / gameElapsedMs) surviving a real process restart —
// same style as spec/persistence.test.ts's restart tests, but exercising
// GAME_TIME_SCALE since ANU-013 introduces it.
import { afterAll, describe, expect, inject, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { spawnServer, type SpawnedServer } from "./lib/spawn-server.ts";
import { pathVertices, minVertexDistance } from "./lib/svg-path.ts";
import { PLAYER_COLORS } from "../server/protocol.ts";

const baseUrl = inject("baseUrl");

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
}

function connect(url: string, token?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
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

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.hypot(ar - br, ag - bg, ab - bb);
}

/** Hue in degrees [0, 360) — standard RGB-to-HSL hue component only. */
function hue(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Shortest distance around the 360-degree hue circle. */
function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff);
}

describe("player colors", () => {
  it("assigns every member of a lobby a distinct color", async () => {
    const lobbyName = `color-test-${Date.now()}`;
    const creator = await connect(baseUrl);
    send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "color-creator" });
    const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
    const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

    const joiners = [];
    for (let i = 0; i < 3; i++) {
      const c = await connect(baseUrl);
      send(c, { type: "joinLobby", lobbyId, callsign: `color-joiner-${i}` });
      await waitFor(c, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);
      joiners.push(c);
    }

    const final = await waitFor(
      creator,
      (m) =>
        m.type === "lobbyState" &&
        (m.lobby as { lobbyId: string; members: unknown[] }).lobbyId === lobbyId &&
        (m.lobby as { members: unknown[] }).members.length === 4,
    );
    const members = (final.lobby as { members: { color: string }[] }).members;
    expect(members).toHaveLength(4);
    const colors = members.map((m) => m.color);
    expect(new Set(colors).size, "every member's color must be unique within the lobby").toBe(colors.length);

    for (const c of [creator, ...joiners]) await closeAndWait(c);
  });

  it("keeps a reconnecting member's color (and economy) unchanged", async () => {
    const lobbyName = `color-reconnect-${Date.now()}`;
    const creator = await connect(baseUrl);
    const welcome = creator.messages.find((m) => m.type === "welcome")!;
    const token = welcome.token as string;

    send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "reconnector" });
    const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
    const originalColor = (created.lobby as { members: { color: string }[] }).members[0].color;

    await closeAndWait(creator);

    const resumed = await connect(baseUrl, token);
    const resumedWelcome = resumed.messages.find((m) => m.type === "welcome")!;
    const resumedColor = (resumedWelcome.lobby as { members: { color: string }[] }).members[0].color;
    expect(resumedColor, "a reconnect must not reassign a new color").toBe(originalColor);

    await closeAndWait(resumed);
  });

  it("disjoint from map.js's data-center tier marker colors by hue AND rendered RGB distance, not just inequality", () => {
    const mapCss = readFileSync("server/public/map.css", "utf8");
    const tierColors: string[] = [];
    for (const m of mapCss.matchAll(/\.dc-marker--\w+\s*\{\s*fill:\s*(#[0-9a-fA-F]{6});/g)) {
      tierColors.push(m[1]);
    }
    expect(tierColors.length, "expected to find the three dc-marker tier fill colors in map.css").toBe(3);

    expect(PLAYER_COLORS.length).toBe(12);
    expect(new Set(PLAYER_COLORS).size, "every palette entry must be distinct").toBe(12);

    // Hue: a tier marker and a player color sharing (near-)the-same hue is
    // exactly the failure mode "never mistaken for a data-center marker"
    // guards against — a player's territory fill sitting under a marker of
    // a visually similar hue. 25 degrees is the margin the palette was
    // picked against (every entry actually clears 28+).
    const MIN_HUE_GAP = 25;
    for (const pc of PLAYER_COLORS) {
      for (const tc of tierColors) {
        expect(
          hueDistance(hue(pc), hue(tc)),
          `player color ${pc} (hue ${hue(pc).toFixed(0)}) is too close in hue to data-center marker ${tc} (hue ${hue(tc).toFixed(0)})`,
        ).toBeGreaterThanOrEqual(MIN_HUE_GAP);
      }
    }

    // Rendered RGB distance: a secondary, independent check — lightness/
    // saturation differences can keep two same-ish hues visually distinct,
    // but this palette doesn't rely on that; it clears both bounds.
    const MIN_MARKER_DISTANCE = 60; // below the smallest margin verified when the palette was picked (~80.5)
    for (const pc of PLAYER_COLORS) {
      for (const tc of tierColors) {
        expect(
          rgbDistance(pc, tc),
          `player color ${pc} is too close to data-center marker color ${tc}`,
        ).toBeGreaterThanOrEqual(MIN_MARKER_DISTANCE);
      }
    }

    const MIN_PAIRWISE_DISTANCE = 60; // below the smallest pairwise margin verified when the palette was picked (~78.0)
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      for (let j = i + 1; j < PLAYER_COLORS.length; j++) {
        expect(
          rgbDistance(PLAYER_COLORS[i], PLAYER_COLORS[j]),
          `player colors ${PLAYER_COLORS[i]} and ${PLAYER_COLORS[j]} are too close to each other`,
        ).toBeGreaterThanOrEqual(MIN_PAIRWISE_DISTANCE);
      }
    }
  });

  it("the first 6 colors (what a 4-6 player lobby actually uses) are pairwise distinct in hue, not just overall RGB distance", () => {
    // A small lobby only ever reaches the front of PLAYER_COLORS — if those
    // were grouped by hue-pair (e.g. two greens in slots 1 and 4), most
    // real games would never see the palette's actual hue spread. This
    // checks the ordering property directly, not just "12 colors exist
    // somewhere that are spread out."
    const firstSix = PLAYER_COLORS.slice(0, 6);
    const MIN_HUE_SPREAD = 30;
    for (let i = 0; i < firstSix.length; i++) {
      for (let j = i + 1; j < firstSix.length; j++) {
        expect(
          hueDistance(hue(firstSix[i]), hue(firstSix[j])),
          `the first 6 player colors should be spread across hue — ${firstSix[i]} and ${firstSix[j]} are too close`,
        ).toBeGreaterThanOrEqual(MIN_HUE_SPREAD);
      }
    }
  });
});

describe("spawn-ownership at kickoff", () => {
  it("auto-owns each player's spawn suburb the moment the lobby starts, using the player-COUNT spawn table, not the lobby's configured capacity", async () => {
    // Capacity 12, but started with only the 4-player minimum: PLAN.md says
    // "spawns are computed per lobby from its player count," so this must
    // use the 4-player spawn ring, not the first 4 entries of the 12-player
    // ring (which clusters wherever that larger ring happens to start).
    const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as {
      suburbs: { sal_code: string; name: string }[];
      spawn_table_by_lobby_size: Record<string, { spawns: string[] }>;
    };
    const nameToSalCode = new Map(mapData.suburbs.map((s) => [s.name, s.sal_code]));
    const expectedSalCodes = new Set(
      mapData.spawn_table_by_lobby_size["4"].spawns.map((name) => nameToSalCode.get(name)!),
    );

    const lobbyName = `spawn-ownership-${Date.now()}`;
    const creator = await connect(baseUrl);
    send(creator, { type: "createLobby", name: lobbyName, capacity: 12, callsign: "spawn-creator" });
    const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
    const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

    const joiners = [];
    for (let i = 0; i < 3; i++) {
      const c = await connect(baseUrl);
      send(c, { type: "joinLobby", lobbyId, callsign: `spawn-joiner-${i}` });
      await waitFor(c, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string }).lobbyId === lobbyId);
      joiners.push(c);
    }

    // Before start: no ownership at all.
    const beforeStart = await waitFor(
      creator,
      (m) =>
        m.type === "lobbyState" &&
        (m.lobby as { lobbyId: string; members: unknown[] }).lobbyId === lobbyId &&
        (m.lobby as { members: unknown[] }).members.length === 4,
    );
    expect(Object.keys((beforeStart.lobby as { ownership: Record<string, string> }).ownership)).toHaveLength(0);

    send(creator, { type: "startLobby" });
    const afterStart = await waitFor(
      creator,
      (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started,
    );
    const lobby = afterStart.lobby as { ownership: Record<string, string>; members: { playerId: string }[] };
    const ownedSalCodes = Object.keys(lobby.ownership);
    expect(ownedSalCodes, "each of the 4 players should own exactly one spawn suburb").toHaveLength(4);
    expect(
      new Set(ownedSalCodes),
      "the owned suburbs must be exactly the 4-player spawn table's suburbs, not the 12-player ring's first 4",
    ).toEqual(expectedSalCodes);

    const ownerIds = new Set(Object.values(lobby.ownership));
    const memberIds = new Set(lobby.members.map((m) => m.playerId));
    expect(ownerIds, "every owner must be a real lobby member").toEqual(memberIds);

    for (const c of [creator, ...joiners]) await closeAndWait(c);
  });
});

describe("stored-timestamp rule: game-elapsed time", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "anu013-time-"));
  const servers: SpawnedServer[] = [];
  afterAll(async () => {
    for (const server of servers) await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("survives a real process restart mid-game with correctly scaled elapsed time, not reset or lost", async () => {
    // GAME_TIME_SCALE=60 makes one real second count as one game-minute, so
    // a short real sleep produces an assertable, non-trivial elapsed value.
    const port = 8103;
    const first = await spawnServer({ port, dataDir, gameTimeScale: 60 });
    servers.push(first);

    const lobbyName = `time-test-${Date.now()}`;
    const creator = await connect(first.baseUrl);
    const creatorToken = (creator.messages.find((m) => m.type === "welcome")!.token) as string;
    send(creator, { type: "createLobby", name: lobbyName, capacity: 4, callsign: "time-creator" });
    const created = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { name: string }).name === lobbyName);
    const lobbyId = (created.lobby as { lobbyId: string }).lobbyId;

    send(creator, { type: "startLobby" });
    const started = await waitFor(creator, (m) => m.type === "lobbyState" && (m.lobby as { lobbyId: string; started: boolean }).lobbyId === lobbyId && (m.lobby as { started: boolean }).started);
    const startedAt = (started.lobby as { startedAt: string }).startedAt;
    expect(startedAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 500)); // ~0.5 real s = ~30 game-s at scale 60

    await closeAndWait(creator);
    await first.stop();

    // Bracket the real wall-clock window the server-side computation must
    // fall within: everything from "just before asking for a new server"
    // to "the welcome actually arrived" is real elapsed time since
    // startedAt that GAME_TIME_SCALE=60 must multiply by exactly 60 — a
    // narrow bracket (not a generous fixed tolerance) is what actually
    // proves the scale was applied: if GAME_TIME_SCALE were silently
    // ignored, gameElapsedMs would be ~60x too small and fall outside even
    // this window scaled up.
    const beforeReconnect = Date.now();
    const second = await spawnServer({ port, dataDir, gameTimeScale: 60 });
    servers.push(second);

    // A fresh identity can't rejoin an already-started lobby (no late
    // join) — resume the creator's own identity via their token instead,
    // same pattern as spec/persistence.test.ts's token-resume test.
    const reader = await connect(second.baseUrl, creatorToken);
    const afterReconnect = Date.now();
    const welcome = reader.messages.find((m) => m.type === "welcome")!;
    const resumedLobby = welcome.lobby as { startedAt: string; gameElapsedMs: number };

    expect(resumedLobby.startedAt, "startedAt must be the exact same stored timestamp across the restart, not reset").toBe(startedAt);

    const SCALE = 60;
    const startedAtMs = Date.parse(startedAt);
    const minExpected = (beforeReconnect - startedAtMs) * SCALE;
    const maxExpected = (afterReconnect - startedAtMs) * SCALE;
    // Slack covers clock/rounding imprecision only (tens of real ms), NOT
    // another multiple of SCALE — a slack sized in scaled units big enough
    // to be "generous" would also be big enough to hide a completely
    // dropped scale (gameElapsedMs landing ~60x too low), which is exactly
    // the bug this bracket exists to catch.
    const slack = 300 * SCALE; // 300 real ms of imprecision, scaled
    expect(
      resumedLobby.gameElapsedMs,
      `gameElapsedMs (${resumedLobby.gameElapsedMs}) should fall within [${minExpected}, ${maxExpected}] (+/- ${slack} slack) — (real elapsed since startedAt) * GAME_TIME_SCALE(${SCALE}), bracketed tightly enough that a dropped/ignored scale (which would land ~${SCALE}x too low) fails this`,
    ).toBeGreaterThanOrEqual(minExpected - slack);
    expect(resumedLobby.gameElapsedMs).toBeLessThanOrEqual(maxExpected + slack);

    await closeAndWait(reader);
  });
});

describe("ANU-010's residual risk: split-node geometric adjacency", () => {
  it("every map.json adjacency edge touching a split ACT Remainder node also touches it geometrically in map-geometry.json", () => {
    const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as {
      suburbs: { idx: number; sal_code: string }[];
      edges: { a: number; b: number }[];
    };
    const geometry = JSON.parse(readFileSync("scripts/map/data/map-geometry.json", "utf8")) as {
      suburbs: { sal_code: string; path: string }[];
    };

    const idxToSalCode = new Map(mapData.suburbs.map((s) => [s.idx, s.sal_code]));
    const salCodeToPath = new Map(geometry.suburbs.map((s) => [s.sal_code, s.path]));
    // A multipart-split node's sal_code is "<base>-<part>" (build_adjacency.py
    // / build_geometry.py's identical split logic) — distinguish from an
    // ordinary numeric sal_code, which has no dash.
    const splitSalCodes = new Set(mapData.suburbs.map((s) => s.sal_code).filter((c) => /^\d+-\d+$/.test(c)));
    expect(splitSalCodes.size, "expected at least one split multipart node (Belconnen/Gungahlin remainders)").toBeGreaterThan(0);

    const touchingEdges = mapData.edges.filter(
      (e) => splitSalCodes.has(idxToSalCode.get(e.a)!) || splitSalCodes.has(idxToSalCode.get(e.b)!),
    );
    expect(touchingEdges.length).toBeGreaterThan(0);

    const vertexCache = new Map<string, [number, number][]>();
    function vertices(salCode: string): [number, number][] {
      if (!vertexCache.has(salCode)) {
        const path = salCodeToPath.get(salCode);
        expect(path, `no geometry for sal_code ${salCode}`).toBeDefined();
        vertexCache.set(salCode, pathVertices(path!));
      }
      return vertexCache.get(salCode)!;
    }

    // toposimplify keeps shared suburb borders identical (build_geometry.py's
    // own invariant), so two road-adjacent suburbs' polygons should share an
    // exact vertex — a small tolerance (post-rounding to 0.1 map units)
    // rather than requiring literal floating-point equality.
    const TOLERANCE = 0.5;
    for (const e of touchingEdges) {
      const aCode = idxToSalCode.get(e.a)!;
      const bCode = idxToSalCode.get(e.b)!;
      const distance = minVertexDistance(vertices(aCode), vertices(bCode));
      expect(
        distance,
        `adjacency edge ${aCode} <-> ${bCode} (touching a split node) has no shared geometry — the split pieces don't line up physically`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it("mutation check: the test above actually fails on mismatched geometry (sanity check for the check itself)", () => {
    const mapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8")) as {
      suburbs: { idx: number; sal_code: string }[];
      edges: { a: number; b: number }[];
    };
    const geometry = JSON.parse(readFileSync("scripts/map/data/map-geometry.json", "utf8")) as {
      suburbs: { sal_code: string; path: string }[];
    };

    const idxToSalCode = new Map(mapData.suburbs.map((s) => [s.idx, s.sal_code]));
    const salCodeToPath = new Map(geometry.suburbs.map((s) => [s.sal_code, s.path]));
    const splitSalCodes = [...new Set(mapData.suburbs.map((s) => s.sal_code).filter((c) => /^\d+-\d+$/.test(c)))];
    expect(splitSalCodes.length).toBeGreaterThanOrEqual(2);

    // Swap two split nodes' paths — if they don't already coincidentally
    // touch each other's edges, this must break the adjacency check for at
    // least one of them (proving the check can actually fail).
    const [codeA, codeB] = splitSalCodes;
    const mutatedPaths = new Map(salCodeToPath);
    mutatedPaths.set(codeA, salCodeToPath.get(codeB)!);
    mutatedPaths.set(codeB, salCodeToPath.get(codeA)!);

    const touchingEdges = mapData.edges.filter(
      (e) => idxToSalCode.get(e.a) === codeA || idxToSalCode.get(e.b) === codeA,
    );
    expect(touchingEdges.length).toBeGreaterThan(0);

    const TOLERANCE = 0.5;
    let sawFailure = false;
    for (const e of touchingEdges) {
      const aCode = idxToSalCode.get(e.a)!;
      const bCode = idxToSalCode.get(e.b)!;
      const distance = minVertexDistance(pathVertices(mutatedPaths.get(aCode)!), pathVertices(mutatedPaths.get(bCode)!));
      if (distance > TOLERANCE) sawFailure = true;
    }
    expect(sawFailure, "swapping two split nodes' geometry should break at least one adjacency check").toBe(true);
  });
});
