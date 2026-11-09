// Mechanically checkable parts of the map render layer (ANU-010): the
// geometry file's suburb key set exactly matches map.json's (ANU-006) —
// a mismatch here would silently mislabel which shape belongs to which
// data-center/spawn name — and the map page's markup/data route are served
// correctly. Pan/zoom/tap *behaviour* is verified manually (see the issue's
// Done-when) since it needs a real pointer/viewport, not something jsdom
// can exercise meaningfully.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, inject, it } from "vitest";
import { clampMarkerSize, quadrantAnchor } from "../server/public/marker-offset.js";

const baseUrl = inject("baseUrl");

type MapNode = { idx: number; sal_code: string; name: string; is_remainder: boolean };
type MapData = {
  suburbs: MapNode[];
  data_centers: { name: string; tier: "mega" | "major" | "standard" }[];
  spawn_table_by_lobby_size: Record<string, { spawns: string[] }>;
};
type ViewBox = { x: number; y: number; width: number; height: number };
type GeoSuburb = { sal_code: string; path: string; label_point: [number, number]; bbox: ViewBox };
type MapGeometry = { suburbs: GeoSuburb[]; full_view_box: object; urban_view_box: object };

const map: MapData = JSON.parse(readFileSync("scripts/map/data/map.json", "utf8"));
const geometry: MapGeometry = JSON.parse(readFileSync("scripts/map/data/map-geometry.json", "utf8"));

describe("geometry data integrity", () => {
  it("has exactly the same sal_code set as map.json's suburbs", () => {
    const mapCodes = new Set(map.suburbs.map((s) => s.sal_code));
    const geoCodes = new Set(geometry.suburbs.map((s) => s.sal_code));
    expect(geoCodes.size).toBe(mapCodes.size);
    for (const code of mapCodes) expect(geoCodes.has(code)).toBe(true);
    for (const code of geoCodes) expect(mapCodes.has(code)).toBe(true);
  });

  it("every suburb has a non-empty SVG path and a label point", () => {
    for (const s of geometry.suburbs) {
      expect(s.path.length).toBeGreaterThan(0);
      expect(s.path.startsWith("M")).toBe(true);
      expect(s.label_point).toHaveLength(2);
      expect(Number.isFinite(s.label_point[0])).toBe(true);
      expect(Number.isFinite(s.label_point[1])).toBe(true);
    }
  });

  it("every suburb has a bbox that actually contains its own label_point", () => {
    // ANU-052: build_geometry.py's bbox is the clamp input map.js uses to
    // keep quadrant-anchored markers inside their own suburb — a bbox that
    // didn't contain label_point would make clampMarkerSize produce a
    // negative/zero clearance on some suburb's real data.
    for (const s of geometry.suburbs) {
      const [lx, ly] = s.label_point;
      expect(lx).toBeGreaterThanOrEqual(s.bbox.x);
      expect(lx).toBeLessThanOrEqual(s.bbox.x + s.bbox.width);
      expect(ly).toBeGreaterThanOrEqual(s.bbox.y);
      expect(ly).toBeLessThanOrEqual(s.bbox.y + s.bbox.height);
    }
  });

  it("every data center name resolves to a real suburb with geometry", () => {
    const nameToCode = new Map(map.suburbs.map((s) => [s.name, s.sal_code]));
    const geoCodes = new Set(geometry.suburbs.map((s) => s.sal_code));
    for (const dc of map.data_centers) {
      const code = nameToCode.get(dc.name);
      expect(code, `data center '${dc.name}' has no matching suburb`).toBeDefined();
      expect(geoCodes.has(code!), `data center '${dc.name}' has no geometry`).toBe(true);
    }
  });

  it("every spawn name (every lobby size) resolves to a real suburb with geometry", () => {
    const nameToCode = new Map(map.suburbs.map((s) => [s.name, s.sal_code]));
    const geoCodes = new Set(geometry.suburbs.map((s) => s.sal_code));
    for (const entry of Object.values(map.spawn_table_by_lobby_size)) {
      for (const name of entry.spawns) {
        const code = nameToCode.get(name);
        expect(code, `spawn '${name}' has no matching suburb`).toBeDefined();
        expect(geoCodes.has(code!), `spawn '${name}' has no geometry`).toBe(true);
      }
    }
  });
});

describe("marker footprint stays inside its own suburb (ANU-052 regression)", () => {
  const DATA_CENTER_SIZES = { mega: 900, major: 640, standard: 440 } as const;
  const nameToSalCode = new Map(map.suburbs.map((s) => [s.name, s.sal_code]));
  const salCodeToGeo = new Map(geometry.suburbs.map((s) => [s.sal_code, s]));

  it("City (mega tier, the measured overflow case from issues/ANU-052.md) no longer extends past its own bbox", () => {
    const salCode = nameToSalCode.get("City");
    const geo = salCode ? salCodeToGeo.get(salCode) : undefined;
    expect(geo, "City suburb must exist with geometry").toBeDefined();
    if (!geo) return;

    const rawSize = DATA_CENTER_SIZES.mega;
    const clampedSize = clampMarkerSize(geo.label_point, rawSize, -1, -1, geo.bbox);
    // This is the actual bug: label_point's clearance to City's own bbox is
    // less than the mega marker's 900-unit size, so the clamp must kick in.
    expect(clampedSize).toBeLessThan(rawSize);

    const [cx, cy] = quadrantAnchor(geo.label_point, clampedSize, -1, -1);
    const minX = cx - clampedSize / 2;
    const minY = cy - clampedSize / 2;
    expect(minX).toBeGreaterThanOrEqual(geo.bbox.x);
    expect(minY).toBeGreaterThanOrEqual(geo.bbox.y);
  });

  it("every data center's marker (clamped) stays within its own suburb's bbox, in all four directions it could anchor", () => {
    for (const dc of map.data_centers) {
      const salCode = nameToSalCode.get(dc.name);
      const geo = salCode ? salCodeToGeo.get(salCode) : undefined;
      if (!geo) continue;
      for (const [dirX, dirY] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        const size = clampMarkerSize(geo.label_point, DATA_CENTER_SIZES[dc.tier], dirX, dirY, geo.bbox);
        const [cx, cy] = quadrantAnchor(geo.label_point, size, dirX, dirY);
        const minX = cx - size / 2;
        const minY = cy - size / 2;
        const maxX = cx + size / 2;
        const maxY = cy + size / 2;
        expect(minX, `${dc.name} dir(${dirX},${dirY}) minX`).toBeGreaterThanOrEqual(geo.bbox.x - 0.01);
        expect(minY, `${dc.name} dir(${dirX},${dirY}) minY`).toBeGreaterThanOrEqual(geo.bbox.y - 0.01);
        expect(maxX, `${dc.name} dir(${dirX},${dirY}) maxX`).toBeLessThanOrEqual(geo.bbox.x + geo.bbox.width + 0.01);
        expect(maxY, `${dc.name} dir(${dirX},${dirY}) maxY`).toBeLessThanOrEqual(geo.bbox.y + geo.bbox.height + 0.01);
      }
    }
  });
});

describe("map data route", () => {
  it("serves /map/map.json as valid JSON matching the baked file", async () => {
    const res = await fetch(new URL("/map/map.json", baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const served = await res.json();
    expect(served.suburbs).toHaveLength(map.suburbs.length);
  });

  it("serves /map/map-geometry.json as valid JSON matching the baked file", async () => {
    const res = await fetch(new URL("/map/map-geometry.json", baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    const served = await res.json();
    expect(served.suburbs).toHaveLength(geometry.suburbs.length);
  });

  it("only serves the two known map files, not an arbitrary path under /map/", async () => {
    // server/index.ts matches /map/ by exact pathname (map.json or
    // map-geometry.json), not a prefix-strip-and-serve — so /map/<anything
    // else> should 404 rather than fall through to serving MAP_DATA_DIR's
    // other contents. (A URL-encoded '..' segment is collapsed by the
    // fetch/URL parser before the request is even sent, so it can't reach
    // the server as a literal traversal attempt; this checks the actual
    // route guard instead.)
    const res = await fetch(new URL("/map/package.json", baseUrl));
    expect(res.status).toBe(404);
  });
});

describe("map page markup", () => {
  // ANU-011: the map is no longer its own page — it's embedded (hidden
  // until a lobby is started) in the lobby screen served from index.html.
  // See spec/gui.test.ts for the started-vs-waiting visibility behaviour;
  // this just checks the static scaffolding is actually there to mount into.
  it("serves the map container, legend and attribution inside the lobby screen", async () => {
    const res = await fetch(new URL("/", baseUrl));
    expect(res.status).toBe(200);
    const dom = new JSDOM(await res.text());
    const { document } = dom.window;

    expect(document.querySelector("#map-panel")).not.toBeNull();
    expect(document.querySelector("#map-svg")).not.toBeNull();
    expect(document.querySelector("#map-suburbs")).not.toBeNull();
    expect(document.querySelector("#map-data-centers")).not.toBeNull();
    expect(document.querySelector("#map-spawns")).not.toBeNull();
    expect(document.querySelector("#map-attribution")).not.toBeNull();
    expect(document.querySelector(".map-legend")).not.toBeNull();
  });

  it("serves /map.js as an executable module script", async () => {
    const res = await fetch(new URL("/map.js", baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it("serves /map.css referenced by the page", async () => {
    const res = await fetch(new URL("/map.css", baseUrl));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/css/);
  });
});
