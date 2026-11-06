// @ts-check
// Map panel (ANU-010, mounted into the lobby screen by ANU-011):
// render-and-inspect only — no ownership, no attacks. `app.js` imports this
// module and calls `mountMap` once a lobby is `started` — see
// issues/ANU-011.md. The markup (`#map-svg` etc.) lives statically in
// index.html's lobby screen, just hidden until then, so this module's
// `getElementById` calls at the top (run once, when app.js imports it) are
// safe regardless of mount order.
//
// No top-level `await` here: that would block app.js's own module
// evaluation and, with it, the WebSocket connection. Data fetching is
// deferred to `mountMap`, called only once a lobby actually needs the map.
//
// Data: scripts/map/data/map.json (the adjacency/balance graph, ANU-006)
// and scripts/map/data/map-geometry.json (suburb polygons, ANU-010), both
// served read-only under /map/ by server/index.ts. Suburbs join across the
// two files by `sal_code`; data centers and spawns join to a suburb by
// `name` (map.json has no sal_code on data_centers/spawn entries).
//
// ANU-020 adds three composed layer functions (renderOwnership/renderUnits/
// renderFactories, per ANU-013's file-layout convention) plus an `onSelect`
// callback on mountMap so app.js/sidebar.js can react to a tap on a suburb,
// unit or factory. None of the three diff against prior state — same
// full-redraw-on-broadcast precedent renderSpawns already uses — since
// nothing they touch resets the viewBox.
//
// ANU-017 adds a fourth, renderCapture, into #map-ownership (stripes)
// and #map-capture-progress (topmost): diagonal stripes (one <pattern> per rendered stripe layer, via
// zoneVisual's pure output) and a progress bar under the suburb's icon, both per
// suburb currently mid-capture — sparse, same full-redraw precedent.
//
// ANU-038 adds a fifth, renderTransit, into #map-transit (between #map-units
// and #map-factories): a dotted origin-to-destination line, progress mark
// and archetype icon per in-transit unit group, replacing the grounded
// marker renderUnits no longer draws for a unit mid-travel.
import { unitVisual } from "./unit-visual.js";
import { layoutUnitMarkers } from "./unit-marker-layout.js";
import { layoutTransitArrows } from "./transit-visual.js";
import { factoryVisual } from "./factory-visual.js";
import { DATA_CENTER_TIER_ICONS, DATA_CENTER_TIER_MARKER_SIZE } from "./data-center-visual.js";
import { UNIT_ARCHETYPE_ICONS, UNIT_MARKER_SIZE } from "./unit-icon.js";
import { PLAYER_BASE_ICON, PLAYER_BASE_MARKER_SIZE } from "./base-icon.js";
import { zoneVisual } from "./capture-visual.js";

/**
 * @typedef {{idx: number, sal_code: string, name: string, is_remainder: boolean}} MapSuburb
 * @typedef {{name: string, tier: "mega"|"major"|"standard", tflops: number}} DataCenter
 * @typedef {{spawns: string[], min_sep: number, ratio: number, scores: number[]}} SpawnEntry
 * @typedef {{
 *   suburbs: MapSuburb[],
 *   edges: {a: number, b: number, weight: number}[],
 *   data_centers: DataCenter[],
 *   spawn_table_by_lobby_size: Record<string, SpawnEntry>,
 *   source_attribution: Record<string, string>,
 * }} MapData
 * @typedef {{sal_code: string, path: string, label_point: [number, number]}} GeoSuburb
 * @typedef {{x: number, y: number, width: number, height: number}} ViewBox
 * @typedef {{
 *   suburbs: GeoSuburb[],
 *   full_view_box: ViewBox,
 *   urban_view_box: ViewBox,
 *   source_attribution: Record<string, string>,
 * }} MapGeometry
 * @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence
 * @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit
 * @typedef {import("../protocol.ts").FactoryState} FactoryState
 * @typedef {import("../protocol.ts").UnitTypeCatalogEntry} UnitTypeCatalogEntry
 * @typedef {import("../protocol.ts").SuburbCaptureState} SuburbCaptureState
 * @typedef {{type: "suburb", sal_code: string} | {type: "unit", unitId: string} | {type: "factory", factoryId: string} | null} MapSelection
 */

const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.getElementById("map-svg")));
const suburbsLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-suburbs")));
const dcLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-data-centers")));
const spawnLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-spawns")));
const basesLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-bases")));
const unitsLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-units")));
const transitLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-transit")));
const factoriesLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-factories")));
const ownershipLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-ownership")));
const captureProgressLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-capture-progress")));
const captureDefs = /** @type {SVGDefsElement} */ (/** @type {unknown} */ (document.getElementById("map-capture-defs")));
const tooltip = /** @type {HTMLElement} */ (document.getElementById("map-tooltip"));
const container = /** @type {HTMLElement} */ (document.getElementById("map-container"));
const attributionEl = /** @type {HTMLElement} */ (document.getElementById("map-attribution"));

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.url}`);
  return res.json();
}

/** @type {Promise<{mapData: MapData, geometry: MapGeometry}> | null} */
let dataPromise = null;
function loadMapData() {
  if (!dataPromise) {
    dataPromise = Promise.all([fetchJson("/map/map.json"), fetchJson("/map/map-geometry.json")])
      .then(([mapData, geometry]) => ({ mapData, geometry }))
      .catch((err) => {
        // Don't cache a failed fetch forever — a flaky connection shouldn't
        // mean "no map until reload"; the next mountMap() call retries.
        dataPromise = null;
        throw err;
      });
  }
  return dataPromise;
}

/** @type {Map<string, MapSuburb>} */
let sal_codeToName = new Map();
/** @type {Map<string, MapSuburb>} */
let nameToSuburb = new Map();
/** @type {Map<string, DataCenter>} */
let nameToDataCenter = new Map();
/** @type {Map<string, GeoSuburb>} */
let sal_codeToGeo = new Map();
/** @type {MapData | null} */
let mapData = null;

let initialised = false;
// Guards against re-resolving the same lobby's spawn table on every
// lobbyState broadcast (presence flips, etc.) — app.js calls mountMap()
// every time the lobby screen re-renders, not just once.
let mountedLobbyId = /** @type {string | null} */ (null);
let currentLobbySize = "";

/** @type {(selection: MapSelection) => void} */
let onSelect = () => {};

/** Keyed by unit_types.key — needed for unitVisual's maxHealth param. Set once via setUnitCatalog. */
let unitTypesByKey = /** @type {Map<string, UnitTypeCatalogEntry>} */ (new Map());

// ANU-034: layoutUnitMarkers' loss-flash detection needs the PREVIOUS call's
// per-(suburb, owner, archetype) counts — module state here, parallel to
// mountedLobbyId's precedent, rather than threaded through app.js, since
// renderUnits is the only caller and every caller already redraws the whole
// layer from a full occupancy snapshot.
/** @type {Map<string, number>} */
let unitGroupCounts = new Map();

/**
 * app.js calls this once a `unitCatalog` message arrives — independent of
 * mountMap/unmountMap since the catalog is global reference data, not
 * per-lobby state.
 * @param {UnitTypeCatalogEntry[]} unitTypes
 */
export function setUnitCatalog(unitTypes) {
  unitTypesByKey = new Map(unitTypes.map((t) => [t.key, t]));
}

/** @type {Map<string, Set<string>>} */
let adjacency = new Map();

/**
 * Mirrors server/units.ts's own buildAdjacency/groundCanReach exactly (same
 * map.json `edges`) so the ANU-027 "Move units" panel can grey out the
 * robot row for an unreachable destination without a round trip — the
 * server's own check in `moveUnits` stays authoritative; this is a client
 * courtesy only, same precedent as every other client-side gate in this
 * GUI (issues/ANU-013.md's Notes).
 * @param {{a: number, b: number}[]} edges
 * @param {MapSuburb[]} suburbs
 */
function buildAdjacency(edges, suburbs) {
  const idxToSalCode = new Map(suburbs.map((s) => [s.idx, s.sal_code]));
  const result = new Map();
  for (const edge of edges) {
    const a = idxToSalCode.get(edge.a);
    const b = idxToSalCode.get(edge.b);
    if (!a || !b) continue;
    if (!result.has(a)) result.set(a, new Set());
    if (!result.has(b)) result.set(b, new Set());
    result.get(a).add(b);
    result.get(b).add(a);
  }
  return result;
}

/**
 * Whether a "ground" (robot) unit owned by a player who owns `ownedSalCodes`
 * could reach `target` — owned, or road-adjacent to something owned, same
 * rule as server/units.ts's groundCanReach.
 * @param {ReadonlySet<string>} ownedSalCodes
 * @param {string} target
 */
export function groundCanReachSuburb(ownedSalCodes, target) {
  if (ownedSalCodes.has(target)) return true;
  const neighbours = adjacency.get(target);
  if (!neighbours) return false;
  for (const n of neighbours) {
    if (ownedSalCodes.has(n)) return true;
  }
  return false;
}

function cleanLabel(/** @type {string} */ name) {
  return name.replace(/ \(ACT\)$/, "").replace(/^ACT Remainder - (.+?)(?: \[part \d+\])?$/, "Wilderness: $1");
}

/**
 * Resolves a `sal_code` to its display name (ANU-038), same lookup/cleanup
 * `showTooltip`'s own `describe()` uses for the map's tooltip — sidebar.js
 * otherwise has no access to `sal_codeToName`, which is only populated once
 * `mountMap`'s `initOnce()` has fetched map.json. Falls back to the raw
 * `sal_code` before that data has loaded, or for a code map.json doesn't
 * recognise, rather than showing nothing.
 * @param {string} sal_code
 */
export function suburbName(sal_code) {
  const info = sal_codeToName.get(sal_code);
  return info ? cleanLabel(info.name) : sal_code;
}

/**
 * Builds the static suburb/data-center layers and wires up pan/zoom/tap —
 * all independent of any particular lobby, so this only ever runs once per
 * page load, on the first lobby that mounts the map.
 * @param {MapData} data
 * @param {MapGeometry} geometry
 */
function initOnce(data, geometry) {
  if (initialised) return;
  initialised = true;

  sal_codeToName = new Map(data.suburbs.map((s) => [s.sal_code, s]));
  nameToSuburb = new Map(data.suburbs.map((s) => [s.name, s]));
  nameToDataCenter = new Map(data.data_centers.map((dc) => [dc.name, dc]));
  sal_codeToGeo = new Map(geometry.suburbs.map((g) => [g.sal_code, g]));
  adjacency = buildAdjacency(data.edges, data.suburbs);

  // --- static suburb layer --- //

  for (const geo of geometry.suburbs) {
    const info = sal_codeToName.get(geo.sal_code);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", geo.path);
    path.setAttribute("class", info?.is_remainder ? "suburb remainder" : "suburb");
    path.dataset.salCode = geo.sal_code;
    suburbsLayer.appendChild(path);
  }

  // --- data center markers (fixed across lobby sizes) --- //

  for (const dc of data.data_centers) {
    const suburb = nameToSuburb.get(dc.name);
    if (!suburb) continue; // a data center name that doesn't resolve to a suburb is a data bug, not something to render around
    const geo = sal_codeToGeo.get(suburb.sal_code);
    if (!geo) continue;
    const [x, y] = geo.label_point;
    const size = DATA_CENTER_TIER_MARKER_SIZE[dc.tier];
    const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
    image.setAttribute("href", DATA_CENTER_TIER_ICONS[dc.tier]);
    image.setAttribute("x", String(x - size / 2));
    image.setAttribute("y", String(y - size / 2));
    image.setAttribute("width", String(size));
    image.setAttribute("height", String(size));
    // Source icons are 32x32 — let the browser scale them up without
    // smoothing, same as any other pixel-art asset, instead of blurring.
    image.setAttribute("image-rendering", "pixelated");
    image.setAttribute("class", `dc-marker dc-marker--${dc.tier}`);
    image.dataset.salCode = suburb.sal_code;
    dcLayer.appendChild(image);
  }

  // --- attribution --- //

  attributionEl.textContent = `Map data: ${Object.values({
    ...data.source_attribution,
    ...geometry.source_attribution,
  }).join(" · ")}`;

  setupPanZoomAndTap(geometry);
}

// ANU-0??: the spawn-ring circle markers were removed from the map (left
// each spawn suburb indistinguishable on the suburb layer itself, same as
// before any base/ownership marker exists) — #map-spawns stays in the DOM
// (spec/map-geometry.test.ts checks for it) and currentLobbySize still
// updates here, since describe()'s "Spawn candidate" tooltip text and the
// capacity-guard in mountMap both depend on it independent of the visual.
function renderSpawns(/** @type {string} */ lobbySize) {
  spawnLayer.replaceChildren();
  currentLobbySize = lobbySize;
}

/**
 * Mounts (or re-targets) the map panel for a specific started lobby —
 * idempotent per (lobbyId, capacity) pair, since app.js re-renders the
 * lobby screen on every `lobbyState` broadcast. The resolved spawn table is
 * locked to this lobby's own capacity — there's a real lobby here, not an
 * abstract size picker.
 * @param {string} lobbyId
 * @param {number} capacity
 * @param {(selection: MapSelection) => void} [selectCallback] - fired on
 *   every tap (a suburb, a unit/factory icon, or null on deselect) — ANU-020.
 */
export async function mountMap(lobbyId, capacity, selectCallback) {
  if (selectCallback) onSelect = selectCallback;
  const { mapData: data, geometry } = await loadMapData();
  mapData = data;
  initOnce(data, geometry);
  if (mountedLobbyId === lobbyId && currentLobbySize === String(capacity)) return;
  mountedLobbyId = lobbyId;
  renderSpawns(String(capacity));
}

/** Clears mount state so a later mountMap() for a different lobby re-resolves the spawn table. */
export function unmountMap() {
  mountedLobbyId = null;
  // ANU-034: otherwise a fresh lobby's first renderUnits call would diff
  // against the previous lobby's leftover counts and could misfire a loss
  // flash on units that were never actually lost.
  unitGroupCounts = new Map();
}

/**
 * Colors the existing `.suburb` paths by owner (ANU-020) — leaves the
 * reserved `#map-ownership` layer (ANU-017's diagonal-stripe contest
 * visuals) untouched. Full redraw on every call: resetting a fill/class on
 * an already-existing permanent path element doesn't touch the viewBox, so
 * there's no pan/zoom-preserving diffing needed here.
 * @param {Record<string, string>} ownership - sal_code -> owner playerId, sparse
 * @param {PlayerPresence[]} members
 */
export function renderOwnership(ownership, members) {
  const colorByPlayerId = new Map(members.map((m) => [m.playerId, m.color]));
  for (const path of suburbsLayer.querySelectorAll("path")) {
    const salCode = /** @type {SVGPathElement} */ (path).dataset.salCode;
    const ownerPlayerId = salCode ? ownership[salCode] : undefined;
    const color = ownerPlayerId ? colorByPlayerId.get(ownerPlayerId) : undefined;
    if (color) {
      path.setAttribute("style", `fill: ${color}; fill-opacity: 0.45;`);
    } else {
      path.removeAttribute("style"); // back to the default .suburb/.suburb.remainder fill
    }
  }
}

/**
 * Populates #map-bases with one skull marker per player who still holds
 * their kickoff spawn suburb (ANU-025) — a player's `spawnSalCode` is set
 * once at kickoff and never changes, but the marker itself disappears the
 * moment `ownership[spawnSalCode]` no longer equals that player, since this
 * reads current ownership fresh on every call rather than caching whether
 * the base was ever captured. Same full-redraw precedent as
 * renderOwnership/renderUnits/renderFactories — called alongside
 * renderOwnership since both depend on the same `ownership` broadcast.
 * Decorative only (like `.dc-marker`): no dataset/click
 * handling, since a base marker isn't a selectable game object.
 * @param {Record<string, string>} ownership - sal_code -> owner playerId, sparse
 * @param {PlayerPresence[]} members
 */
export function renderBases(ownership, members) {
  basesLayer.replaceChildren();
  const size = PLAYER_BASE_MARKER_SIZE;
  for (const member of members) {
    if (!member.spawnSalCode) continue; // lobby hasn't started, or no spawn-table entry for this lobby size
    if (ownership[member.spawnSalCode] !== member.playerId) continue; // base captured by someone else — no marker
    const geo = sal_codeToGeo.get(member.spawnSalCode);
    if (!geo) continue;
    const [x, y] = geo.label_point;

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "base-marker");

    const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    backdrop.setAttribute("x", String(x - size / 2));
    backdrop.setAttribute("y", String(y - size / 2));
    backdrop.setAttribute("width", String(size));
    backdrop.setAttribute("height", String(size));
    backdrop.setAttribute("class", "base-marker__backdrop");
    backdrop.setAttribute("style", `fill: ${member.color};`);

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "image");
    icon.setAttribute("href", PLAYER_BASE_ICON);
    icon.setAttribute("x", String(x - size / 2));
    icon.setAttribute("y", String(y - size / 2));
    icon.setAttribute("width", String(size));
    icon.setAttribute("height", String(size));
    icon.setAttribute("image-rendering", "pixelated");
    icon.setAttribute("class", "base-marker__icon");

    group.appendChild(backdrop);
    group.appendChild(icon);
    basesLayer.appendChild(group);
  }
}

/**
 * Renders ANU-017's diagonal-stripe contest visuals, plus a progress bar
 * (into the topmost #map-capture-progress layer, just below the suburb's icon)
 * — stripes go into the reserved #map-ownership layer, via the already-tested
 * zoneVisual() pure function. Full redraw on every `captures` broadcast —
 * same replaceChildren-then-rebuild precedent as renderUnits/renderFactories
 * (sparse: only suburbs currently returned may have an active capture).
 * @param {SuburbCaptureState[]} captures
 * @param {Record<string, string>} ownership
 * @param {PlayerPresence[]} members
 */
export function renderCapture(captures, ownership, members) {
  ownershipLayer.replaceChildren();
  captureProgressLayer.replaceChildren();
  captureDefs.replaceChildren();
  const colorByPlayerId = new Map(members.map((m) => [m.playerId, m.color]));

  for (const capture of captures) {
    const geo = sal_codeToGeo.get(capture.sal_code);
    if (!geo) continue;
    const { stripes, progress } = zoneVisual({
      ownerPlayerId: ownership[capture.sal_code] ?? null,
      capture,
      colorByPlayerId,
    });
    if (stripes.length === 0) continue; // fill-only (case 1) never applies here — captures is already sparse to in-progress suburbs

    // Non-overlapping diagonal stripes (issues/ANU-017.md: "do not let the
    // stripes overlap"): each stripe gets its own <pattern>, tiled the same
    // way, but painting only its own 1/N vertical band of each tile BEFORE
    // the shared 45-degree rotation — so N stripes partition each tile's
    // diagonal period into N parallel bands instead of drawing over the
    // same pixels.
    const TILE = 320;
    const n = stripes.length;
    stripes.forEach((stripe, i) => {
      const patternId = `capture-stripe-${capture.sal_code}-${i}`;
      const pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
      pattern.setAttribute("id", patternId);
      pattern.setAttribute("patternUnits", "userSpaceOnUse");
      pattern.setAttribute("width", String(TILE));
      pattern.setAttribute("height", String(TILE));
      pattern.setAttribute("patternTransform", "rotate(45)");
      const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      band.setAttribute("x", String((i * TILE) / n));
      band.setAttribute("y", "0");
      band.setAttribute("width", String(TILE / n));
      band.setAttribute("height", String(TILE));
      band.setAttribute("fill", stripe.color);
      pattern.appendChild(band);
      captureDefs.appendChild(pattern);

      const overlay = document.createElementNS("http://www.w3.org/2000/svg", "path");
      overlay.setAttribute("d", geo.path);
      overlay.setAttribute("fill", `url(#${patternId})`);
      overlay.setAttribute(
        "class",
        stripe.pulsing ? "capture-stripe capture-stripe--pulsing" : "capture-stripe",
      );
      ownershipLayer.appendChild(overlay);
    });

    if (progress !== null) {
      const [x, cy] = geo.label_point;
      const BAR_WIDTH = 900;
      const BAR_HEIGHT = 140;
      // Sit the bar just under the unit/base icon centered on label_point
      // (instead of across it), so the icon never draws over the bar.
      const ICON_HALF = Math.max(UNIT_MARKER_SIZE, PLAYER_BASE_MARKER_SIZE) / 2;
      const BAR_GAP = 60;
      const y = cy + ICON_HALF + BAR_GAP + BAR_HEIGHT / 2;
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("class", "capture-progress");
      const track = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      track.setAttribute("x", String(x - BAR_WIDTH / 2));
      track.setAttribute("y", String(y - BAR_HEIGHT / 2));
      track.setAttribute("width", String(BAR_WIDTH));
      track.setAttribute("height", String(BAR_HEIGHT));
      track.setAttribute("class", "capture-progress__track");
      const fillBar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      fillBar.setAttribute("x", String(x - BAR_WIDTH / 2));
      fillBar.setAttribute("y", String(y - BAR_HEIGHT / 2));
      fillBar.setAttribute("width", String(BAR_WIDTH * progress));
      fillBar.setAttribute("height", String(BAR_HEIGHT));
      fillBar.setAttribute("class", "capture-progress__fill");
      group.append(track, fillBar);
      captureProgressLayer.appendChild(group);
    }
  }
}

// ANU-034: horizontal gap between two archetype groups fanned out at the
// same suburb — visibly separate, same spirit as BAR_GAP below, but applied
// between icons instead of between an icon and its progress bar.
const UNIT_GROUP_GAP = 80;
// Vertical gap between an icon's bottom edge and its count label.
const UNIT_COUNT_GAP = 40;

/**
 * Populates #map-units with one marker per (suburb, owner, archetype) group
 * (ANU-034 — previously one marker per individual occupant, ANU-020/024),
 * via the already-tested unitVisual()/layoutUnitMarkers(). Groups sharing a
 * suburb are fanned out left-to-right around label_point instead of all
 * drawn at the same point, so a drone and a robot (or two owners' units) at
 * one tile no longer fully occlude each other. Each group shows its count
 * as white text beneath the icon, which flashes/jitters (`.unit-marker--lost`,
 * map.css) when layoutUnitMarkers reports the group's count just dropped.
 * Full redraw on every `occupancy` broadcast — same replaceChildren-then-
 * rebuild precedent as renderSpawns.
 *
 * ANU-038: an in-transit unit is excluded here — it no longer "occupies" its
 * origin suburb once dispatched (same rule server/units.ts's
 * selectOccupantsAt enforces server-side), and is drawn instead by
 * renderTransit's dotted arrow, which is what actually represents it while
 * it's between suburbs. Showing both a dimmed origin marker AND a travel
 * arrow for the same unit would be redundant.
 * @param {OccupantUnit[]} units
 * @param {PlayerPresence[]} members
 */
export function renderUnits(units, members) {
  unitsLayer.replaceChildren();
  const colorByPlayerId = new Map(members.map((m) => [m.playerId, m.color]));

  const resolved = units
    .map((unit) => {
      const unitType = unitTypesByKey.get(unit.unitTypeKey);
      const visual = unitVisual(unit, unitType?.health ?? unit.health);
      return {
        id: unit.id,
        sal_code: unit.sal_code,
        ownerPlayerId: unit.ownerPlayerId,
        archetype: visual.icon,
        inTransit: visual.state === "in-transit",
      };
    })
    .filter((unit) => !unit.inTransit);
  const { groups, nextCountByGroupKey } = layoutUnitMarkers(resolved, unitGroupCounts);
  unitGroupCounts = nextCountByGroupKey;

  for (const unitGroup of groups) {
    const geo = sal_codeToGeo.get(unitGroup.sal_code);
    if (!geo) continue;
    const [cx, cy] = geo.label_point;
    const size = UNIT_MARKER_SIZE;

    // Center the whole row of this suburb's groups on label_point, rather
    // than left-aligning from it, so a single group still sits exactly
    // where the old one-marker-per-tile code drew it.
    const rowWidth = unitGroup.groupCountAtSalCode * size + (unitGroup.groupCountAtSalCode - 1) * UNIT_GROUP_GAP;
    const x = cx - rowWidth / 2 + unitGroup.offsetIndex * (size + UNIT_GROUP_GAP) + size / 2;
    const y = cy;

    // ANU-024: a colored-square backdrop (owner's color, same visual
    // language as .factory-marker) with the archetype's icon layered on
    // top — the icon itself is a fixed color (see unit-icon.js), so
    // ownership is conveyed by the backdrop rather than an icon fill.
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute(
      "class",
      `unit-marker unit-marker--${unitGroup.archetype} unit-marker--${unitGroup.inTransit ? "in-transit" : "grounded"}`,
    );

    const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    backdrop.setAttribute("x", String(x - size / 2));
    backdrop.setAttribute("y", String(y - size / 2));
    backdrop.setAttribute("width", String(size));
    backdrop.setAttribute("height", String(size));
    backdrop.setAttribute("class", "unit-marker__backdrop");
    backdrop.setAttribute("style", `fill: ${colorByPlayerId.get(unitGroup.ownerPlayerId) ?? "#888"};`);

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "image");
    icon.setAttribute("href", UNIT_ARCHETYPE_ICONS[unitGroup.archetype]);
    icon.setAttribute("x", String(x - size / 2));
    icon.setAttribute("y", String(y - size / 2));
    icon.setAttribute("width", String(size));
    icon.setAttribute("height", String(size));
    icon.setAttribute("image-rendering", "pixelated");
    icon.setAttribute("class", "unit-marker__icon");

    // ANU-034: "xN" count readout beneath the icon — white by default,
    // toggled to the flash/jitter animation (map.css) via the modifier
    // class below when layoutUnitMarkers reports a drop since last render.
    const count = document.createElementNS("http://www.w3.org/2000/svg", "text");
    count.setAttribute("x", String(x));
    count.setAttribute("y", String(y + size / 2 + UNIT_COUNT_GAP));
    count.setAttribute("text-anchor", "middle");
    count.setAttribute("dominant-baseline", "hanging");
    count.setAttribute(
      "class",
      unitGroup.lostAUnit ? "unit-marker__count unit-marker__count--lost" : "unit-marker__count",
    );
    count.textContent = `x${unitGroup.count}`;

    // All three children carry the same dataset — the click handler
    // hit-tests via elementFromPoint, which resolves to whichever element
    // is topmost at the clicked pixel (the icon image, painted last over
    // the backdrop; the count label sits below the icon's footprint so it
    // never overlaps either). sampleUnitId picks one representative unit
    // from the group for selection, since a group no longer maps 1:1 to a
    // single OccupantUnit the way a pre-ANU-034 marker did.
    for (const el of [backdrop, icon, count]) {
      el.dataset.unitId = unitGroup.sampleUnitId;
      el.dataset.salCode = unitGroup.sal_code;
      group.appendChild(el);
    }
    unitsLayer.appendChild(group);
  }
}

// Marker for a travelling group's progress-mark icon is drawn a little
// smaller than a grounded unit marker (UNIT_MARKER_SIZE) — it's riding a
// thin line between two suburbs, not sitting centered on one, so a
// full-size icon would visually overwhelm the arrow it's meant to be a mark
// on.
const TRANSIT_MARKER_SIZE = UNIT_MARKER_SIZE * 0.7;

/**
 * Populates #map-transit with one dotted arrow per in-transit unit group
 * (ANU-038 — grouped by (origin, destination, owner, archetype), via the
 * already-tested unitVisual()/layoutTransitArrows()), replacing the
 * grounded marker renderUnits no longer draws for these units while they're
 * mid-travel. Each arrow is a dashed line from the origin's label_point to
 * the destination's, a small owner-colored+archetype-iconed marker riding
 * the line at the group's live progress fraction (the LEAST-advanced
 * member's, so a trailing straggler is never drawn ahead of where it really
 * is), and an "xN" count when more than one unit shares the exact trip.
 * Full redraw on every `occupancy` broadcast — same replaceChildren-then-
 * rebuild precedent as renderUnits/renderSpawns.
 * @param {OccupantUnit[]} units
 * @param {PlayerPresence[]} members
 */
export function renderTransit(units, members) {
  transitLayer.replaceChildren();
  const colorByPlayerId = new Map(members.map((m) => [m.playerId, m.color]));

  /** @type {import("./transit-visual.js").ResolvedTransitUnit[]} */
  const resolved = [];
  for (const unit of units) {
    const unitType = unitTypesByKey.get(unit.unitTypeKey);
    const visual = unitVisual(unit, unitType?.health ?? unit.health);
    if (visual.state !== "in-transit" || unit.destinationSalCode === undefined) continue;
    resolved.push({
      id: unit.id,
      sal_code: unit.sal_code,
      destinationSalCode: unit.destinationSalCode,
      travelProgressFraction: unit.travelProgressFraction ?? 0,
      ownerPlayerId: unit.ownerPlayerId,
      archetype: visual.icon,
    });
  }

  for (const transitGroup of layoutTransitArrows(resolved)) {
    const originGeo = sal_codeToGeo.get(transitGroup.sal_code);
    const destGeo = sal_codeToGeo.get(transitGroup.destinationSalCode);
    if (!originGeo || !destGeo) continue;
    const [ox, oy] = originGeo.label_point;
    const [dx, dy] = destGeo.label_point;
    const ownerColor = colorByPlayerId.get(transitGroup.ownerPlayerId) ?? "#888";

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", `transit-arrow transit-arrow--${transitGroup.archetype}`);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(ox));
    line.setAttribute("y1", String(oy));
    line.setAttribute("x2", String(dx));
    line.setAttribute("y2", String(dy));
    line.setAttribute("class", "transit-arrow__line");
    line.setAttribute("style", `stroke: ${ownerColor};`);
    group.appendChild(line);

    // The progress mark's position along the origin-to-destination line —
    // derived at render time from the group's (least-advanced-member's)
    // travelProgressFraction, same "server sends a timestamp/fraction,
    // client interpolates the drawable position" split capture progress
    // bars already use.
    const px = ox + (dx - ox) * transitGroup.travelProgressFraction;
    const py = oy + (dy - oy) * transitGroup.travelProgressFraction;
    const size = TRANSIT_MARKER_SIZE;

    const backdrop = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    backdrop.setAttribute("x", String(px - size / 2));
    backdrop.setAttribute("y", String(py - size / 2));
    backdrop.setAttribute("width", String(size));
    backdrop.setAttribute("height", String(size));
    backdrop.setAttribute("class", "transit-arrow__backdrop");
    backdrop.setAttribute("style", `fill: ${ownerColor};`);
    group.appendChild(backdrop);

    const icon = document.createElementNS("http://www.w3.org/2000/svg", "image");
    icon.setAttribute("href", UNIT_ARCHETYPE_ICONS[transitGroup.archetype]);
    icon.setAttribute("x", String(px - size / 2));
    icon.setAttribute("y", String(py - size / 2));
    icon.setAttribute("width", String(size));
    icon.setAttribute("height", String(size));
    icon.setAttribute("image-rendering", "pixelated");
    icon.setAttribute("class", "transit-arrow__icon");
    group.appendChild(icon);

    if (transitGroup.count > 1) {
      const count = document.createElementNS("http://www.w3.org/2000/svg", "text");
      count.setAttribute("x", String(px));
      count.setAttribute("y", String(py + size / 2 + UNIT_COUNT_GAP));
      count.setAttribute("text-anchor", "middle");
      count.setAttribute("dominant-baseline", "hanging");
      count.setAttribute("class", "transit-arrow__count");
      count.textContent = `x${transitGroup.count}`;
      group.appendChild(count);
    }

    // Same dataset-driven click-selection convention as renderUnits — a tap
    // on an in-transit group's marker resolves to its sampleUnitId, same
    // "one representative unit stands in for the group" rule.
    for (const el of [backdrop, icon]) {
      el.dataset.unitId = transitGroup.sampleUnitId;
    }
    transitLayer.appendChild(group);
  }
}

/**
 * Populates #map-factories with one icon per factory (ANU-020), via the
 * already-tested factoryVisual(). Same full-redraw precedent as renderUnits.
 * @param {FactoryState[]} factoryList
 * @param {PlayerPresence[]} members
 */
export function renderFactories(factoryList, members) {
  factoriesLayer.replaceChildren();
  const colorByPlayerId = new Map(members.map((m) => [m.playerId, m.color]));
  for (const factory of factoryList) {
    const geo = sal_codeToGeo.get(factory.sal_code);
    if (!geo) continue;
    const visual = factoryVisual(factory, colorByPlayerId.get(factory.ownerPlayerId) ?? "#888");
    const [x, y] = geo.label_point;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const size = 280;
    rect.setAttribute("x", String(x - size / 2));
    rect.setAttribute("y", String(y - size / 2));
    rect.setAttribute("width", String(size));
    rect.setAttribute("height", String(size));
    rect.setAttribute("class", "factory-marker");
    rect.setAttribute("style", `fill: ${visual.ownerColor};`);
    rect.dataset.factoryId = factory.id;
    rect.dataset.salCode = factory.sal_code;
    factoriesLayer.appendChild(rect);
  }
}

// --- pan/zoom (pointer events, so it works with mouse, touch and pen alike) --- //
//
// Coordinate math goes through the SVG's own getScreenCTM(), not container
// getBoundingClientRect() fractions: the urban viewBox is portrait while the
// desktop container is landscape, so preserveAspectRatio="meet" letterboxes
// the rendered map inside the container — a client-rect-fraction mapping is
// wrong by exactly the letterbox gap, in whichever axis is boxed. The CTM
// already encodes the real scale/offset the browser is using, independent
// of which axis ends up letterboxed at a given viewport size. Only called
// from initOnce, once the lobby screen (and this panel) is already
// unhidden, so getScreenCTM() has real layout to read.

/** @type {ViewBox} */
let viewBox = { x: 0, y: 0, width: 0, height: 0 };
/** @type {ViewBox} */
let fullBounds = { x: 0, y: 0, width: 0, height: 0 };
/** @type {MapGeometry | null} */
let activeGeometry = null;

function applyViewBox() {
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
}

// Keep at least a sliver of the map on screen; don't let pan/zoom lose the
// board entirely. Width/height stay bounded between a close-in zoom and the
// full map extent, with the aspect ratio always matching urban_view_box's —
// that invariant is what keeps the rendered-map size in CSS px constant
// across zoom levels (see zoomAroundClientPoint), not just incidental.
function clampedDims(/** @type {number} */ width) {
  const minW = fullBounds.width / 20;
  const maxW = fullBounds.width * 1.5;
  const clampedWidth = Math.min(maxW, Math.max(minW, width));
  const urban = /** @type {MapGeometry} */ (activeGeometry).urban_view_box;
  const clampedHeight = clampedWidth * (urban.height / urban.width);
  return { width: clampedWidth, height: clampedHeight };
}

/**
 * Sets the viewBox to the given dimensions, then corrects x/y so whatever
 * SVG point was under (clientX, clientY) before the resize is still under
 * it afterwards — anchoring a zoom to the cursor/pinch midpoint rather than
 * to the viewBox's corner. Two-pass (apply, measure the real post-resize
 * CTM, correct) rather than predicting the letterboxed geometry by formula.
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} newWidth
 * @param {number} newHeight
 */
function zoomAroundClientPoint(clientX, clientY, newWidth, newHeight) {
  const ctmBefore = svg.getScreenCTM();
  if (!ctmBefore) return;
  const anchor = new DOMPoint(clientX, clientY).matrixTransform(ctmBefore.inverse());
  viewBox.width = newWidth;
  viewBox.height = newHeight;
  applyViewBox();
  const ctmAfter = svg.getScreenCTM();
  if (!ctmAfter) return;
  const projected = new DOMPoint(anchor.x, anchor.y).matrixTransform(ctmAfter);
  viewBox.x -= (clientX - projected.x) / ctmAfter.a;
  viewBox.y -= (clientY - projected.y) / ctmAfter.d;
  applyViewBox();
}

/** @type {Map<number, {x: number, y: number}>} */
const activePointers = new Map();
/**
 * @type {{
 *   clientX: number, clientY: number,
 *   viewBoxX: number, viewBoxY: number,
 *   unitsPerPxX: number, unitsPerPxY: number,
 * } | null}
 */
let dragStart = null;
let pinchStartDistance = 0;
let pinchStartWidth = 0;
let totalDragDistance = 0;

// Pure translation (width/height unchanged), so the px->unit scale is fixed
// for the whole gesture — read it once from the CTM rather than per move.
function beginDrag(/** @type {number} */ clientX, /** @type {number} */ clientY) {
  const ctm = svg.getScreenCTM();
  dragStart = {
    clientX,
    clientY,
    viewBoxX: viewBox.x,
    viewBoxY: viewBox.y,
    unitsPerPxX: ctm ? 1 / ctm.a : 1,
    unitsPerPxY: ctm ? 1 / ctm.d : 1,
  };
}

function endPointer(/** @type {PointerEvent} */ event) {
  activePointers.delete(event.pointerId);
  if (activePointers.size === 0) {
    dragStart = null;
    pinchStartDistance = 0;
  } else if (activePointers.size === 1) {
    // A pinch just ended with one finger still down. Without reseeding here,
    // the next move would fall into the single-pointer branch using
    // whatever stale `dragStart` was last set (from before the pinch even
    // started), snapping the view back to that point.
    const [remaining] = activePointers.values();
    beginDrag(remaining.x, remaining.y);
    pinchStartDistance = 0;
  }
}

// --- tap/click to inspect (a drag longer than this threshold isn't a tap) --- //

const TAP_THRESHOLD_PX = 8;
let selected = /** @type {SVGElement | null} */ (null);

function describe(/** @type {string} */ sal_code) {
  const info = sal_codeToName.get(sal_code);
  if (!info) return null;
  const dc = nameToDataCenter.get(info.name);
  const lines = [];
  if (dc) lines.push(`${dc.tier} data center — ${dc.tflops} TFLOPS`);
  const currentEntry = mapData?.spawn_table_by_lobby_size[currentLobbySize];
  if (currentEntry?.spawns.includes(info.name)) lines.push(`Spawn candidate (${currentLobbySize}-player lobby)`);
  if (info.is_remainder) lines.push("Wilderness — ownable, no data center or spawn");
  return { name: cleanLabel(info.name), lines };
}

function showTooltip(/** @type {string} */ sal_code) {
  const info = describe(sal_code);
  if (!info) {
    tooltip.hidden = true;
    return;
  }
  tooltip.replaceChildren();
  const h3 = document.createElement("h3");
  h3.textContent = info.name; // textContent only — suburb names come from our own baked data, but no reason to risk innerHTML here either
  tooltip.appendChild(h3);
  for (const line of info.lines.length ? info.lines : ["Ordinary suburb — no data center, not a spawn candidate"]) {
    const p = document.createElement("p");
    p.textContent = line;
    tooltip.appendChild(p);
  }
  tooltip.hidden = false;
}

/** @param {MapGeometry} geometry */
function setupPanZoomAndTap(geometry) {
  activeGeometry = geometry;
  viewBox = { ...geometry.urban_view_box };
  fullBounds = geometry.full_view_box;
  applyViewBox();

  container.addEventListener("pointerdown", (event) => {
    container.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    totalDragDistance = 0;
    if (activePointers.size === 1) {
      beginDrag(event.clientX, event.clientY);
    } else if (activePointers.size === 2) {
      dragStart = null; // a second finger landed mid-drag: this gesture is now a pinch, not a pan
      const pts = [...activePointers.values()];
      pinchStartDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchStartWidth = viewBox.width;
    }
  });

  container.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size === 1 && dragStart) {
      const dxPx = event.clientX - dragStart.clientX;
      const dyPx = event.clientY - dragStart.clientY;
      totalDragDistance = Math.hypot(dxPx, dyPx);
      viewBox.x = dragStart.viewBoxX - dxPx * dragStart.unitsPerPxX;
      viewBox.y = dragStart.viewBoxY - dyPx * dragStart.unitsPerPxY;
      applyViewBox();
    } else if (activePointers.size === 2 && pinchStartDistance > 0) {
      const pts = [...activePointers.values()];
      const distance = Math.max(Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), 1);
      const scale = pinchStartDistance / distance;
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const { width, height } = clampedDims(pinchStartWidth * scale);
      zoomAroundClientPoint(midX, midY, width, height);
    }
  });

  container.addEventListener("pointerup", endPointer);
  container.addEventListener("pointercancel", endPointer);

  container.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const zoomFactor = Math.exp(event.deltaY * 0.001);
      const { width, height } = clampedDims(viewBox.width * zoomFactor);
      zoomAroundClientPoint(event.clientX, event.clientY, width, height);
    },
    { passive: false },
  );

  container.addEventListener("click", (event) => {
    if (totalDragDistance > TAP_THRESHOLD_PX) return; // was a pan, not a tap
    // event.target is unreliable here: pointerdown calls setPointerCapture on
    // `container` for panning, which retargets the synthesized click's target
    // to the capturing element instead of whatever's visually under the
    // pointer. Hit-test by coordinate instead.
    const hit = /** @type {SVGElement | null} */ (document.elementFromPoint(event.clientX, event.clientY));
    if (selected) selected.classList.remove("selected");

    // Units/factories are drawn on top of the suburb layer and checked
    // first (ANU-020) — elementFromPoint already resolves to whichever
    // element is topmost in paint order, so this is just reading which
    // dataset field it carries, not a separate z-order computation.
    const unitId = hit?.dataset?.unitId;
    const factoryId = hit?.dataset?.factoryId;
    const sal_code = hit?.dataset?.salCode;

    if (unitId) {
      selected = null;
      tooltip.hidden = true;
      onSelect({ type: "unit", unitId });
      return;
    }
    if (factoryId) {
      selected = null;
      tooltip.hidden = true;
      onSelect({ type: "factory", factoryId });
      return;
    }
    if (!sal_code) {
      tooltip.hidden = true;
      selected = null;
      onSelect(null);
      return;
    }
    const path = suburbsLayer.querySelector(`[data-sal-code="${CSS.escape(sal_code)}"]`);
    if (path) {
      path.classList.add("selected");
      selected = /** @type {SVGElement} */ (path);
    }
    showTooltip(sal_code);
    onSelect({ type: "suburb", sal_code });
  });
}
