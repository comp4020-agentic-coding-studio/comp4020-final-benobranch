// @ts-check
// Standalone map screen (ANU-010): render-and-inspect only — no ownership,
// no attacks, no lobby wiring. Deliberately a separate file/page from
// app.js/index.html (ANU-009 is concurrently rewriting those for the
// Home/Browse/HUD screens) so the two don't collide across worktrees.
//
// Data: scripts/map/data/map.json (the adjacency/balance graph, ANU-006)
// and scripts/map/data/map-geometry.json (suburb polygons, ANU-010), both
// served read-only under /map/ by server/index.ts. Suburbs join across the
// two files by `sal_code`; data centers and spawns join to a suburb by
// `name` (map.json has no sal_code on data_centers/spawn entries).

/**
 * @typedef {{idx: number, sal_code: string, name: string, is_remainder: boolean}} MapSuburb
 * @typedef {{name: string, tier: "mega"|"major"|"standard", tflops: number}} DataCenter
 * @typedef {{spawns: string[], min_sep: number, ratio: number, scores: number[]}} SpawnEntry
 * @typedef {{
 *   suburbs: MapSuburb[],
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
 */

const svg = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (document.getElementById("map-svg")));
const suburbsLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-suburbs")));
const dcLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-data-centers")));
const spawnLayer = /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("map-spawns")));
const tooltip = /** @type {HTMLElement} */ (document.getElementById("map-tooltip"));
const container = /** @type {HTMLElement} */ (document.getElementById("map-container"));
const sizeSelect = /** @type {HTMLSelectElement} */ (document.getElementById("lobby-size-select"));
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

const fetched = await Promise.all([fetchJson("/map/map.json"), fetchJson("/map/map-geometry.json")]);
const mapData = /** @type {MapData} */ (fetched[0]);
const geometry = /** @type {MapGeometry} */ (fetched[1]);

const sal_codeToName = new Map(mapData.suburbs.map((/** @type {MapSuburb} */ s) => [s.sal_code, s]));
const nameToSuburb = new Map(mapData.suburbs.map((/** @type {MapSuburb} */ s) => [s.name, s]));
const nameToDataCenter = new Map(mapData.data_centers.map((/** @type {DataCenter} */ dc) => [dc.name, dc]));
const sal_codeToGeo = new Map(geometry.suburbs.map((/** @type {GeoSuburb} */ g) => [g.sal_code, g]));

function cleanLabel(/** @type {string} */ name) {
  return name.replace(/ \(ACT\)$/, "").replace(/^ACT Remainder - (.+?)(?: \[part \d+\])?$/, "Wilderness: $1");
}

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

/** @type {Record<"mega"|"major"|"standard", number>} */
const MARKER_RADIUS = { mega: 450, major: 320, standard: 220 };

for (const dc of mapData.data_centers) {
  const suburb = nameToSuburb.get(dc.name);
  if (!suburb) continue; // a data center name that doesn't resolve to a suburb is a data bug, not something to render around
  const geo = sal_codeToGeo.get(suburb.sal_code);
  if (!geo) continue;
  const [x, y] = geo.label_point;
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", String(x));
  circle.setAttribute("cy", String(y));
  circle.setAttribute("r", String(MARKER_RADIUS[dc.tier]));
  circle.setAttribute("class", `dc-marker dc-marker--${dc.tier}`);
  circle.dataset.salCode = suburb.sal_code;
  dcLayer.appendChild(circle);
}

// --- spawn ring preview, one lobby size at a time --- //

for (const size of Object.keys(mapData.spawn_table_by_lobby_size).sort((a, b) => Number(a) - Number(b))) {
  const option = document.createElement("option");
  option.value = size;
  option.textContent = `${size} players`;
  sizeSelect.appendChild(option);
}

function renderSpawns(/** @type {string} */ lobbySize) {
  spawnLayer.replaceChildren();
  const entry = mapData.spawn_table_by_lobby_size[lobbySize];
  if (!entry) return;
  for (const name of entry.spawns) {
    const suburb = nameToSuburb.get(name);
    if (!suburb) continue;
    const geo = sal_codeToGeo.get(suburb.sal_code);
    if (!geo) continue;
    const [x, y] = geo.label_point;
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    marker.setAttribute("cx", String(x));
    marker.setAttribute("cy", String(y));
    marker.setAttribute("r", "550");
    marker.setAttribute("class", "spawn-marker");
    marker.dataset.salCode = suburb.sal_code;
    spawnLayer.appendChild(marker);
  }
}

sizeSelect.addEventListener("change", () => renderSpawns(sizeSelect.value));
const defaultSize = "8"; // mid-range lobby size for an illustrative preview
sizeSelect.value = mapData.spawn_table_by_lobby_size[defaultSize] ? defaultSize : sizeSelect.options[0]?.value ?? "";
renderSpawns(sizeSelect.value);

// --- attribution --- //

attributionEl.textContent = `Map data: ${Object.values({
  ...mapData.source_attribution,
  ...geometry.source_attribution,
}).join(" · ")}`;

// --- pan/zoom (pointer events, so it works with mouse, touch and pen alike) --- //

let viewBox = { ...geometry.urban_view_box };
const fullBounds = geometry.full_view_box;

function applyViewBox() {
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
}
applyViewBox();

/** @type {Map<number, {x: number, y: number}>} */
const activePointers = new Map();
/** @type {{x: number, y: number, viewBox: ViewBox} | null} */
let dragStart = null;
let pinchStartDistance = 0;
/** @type {ViewBox | null} */
let pinchStartViewBox = null;
let totalDragDistance = 0;

function svgPointFromClient(/** @type {number} */ clientX, /** @type {number} */ clientY) {
  const rect = container.getBoundingClientRect();
  const sx = viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width;
  const sy = viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height;
  return { x: sx, y: sy };
}

function clampViewBox() {
  // Keep at least a sliver of the map on screen; don't let pan/zoom lose the
  // board entirely. Width/height stay bounded between a close-in zoom and
  // the full map extent.
  const minW = fullBounds.width / 20;
  const maxW = fullBounds.width * 1.5;
  viewBox.width = Math.min(maxW, Math.max(minW, viewBox.width));
  viewBox.height = viewBox.width * (geometry.urban_view_box.height / geometry.urban_view_box.width);
}

container.addEventListener("pointerdown", (event) => {
  container.setPointerCapture(event.pointerId);
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  totalDragDistance = 0;
  if (activePointers.size === 1) {
    dragStart = { x: event.clientX, y: event.clientY, viewBox: { ...viewBox } };
  } else if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    pinchStartDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    pinchStartViewBox = { ...viewBox };
  }
});

container.addEventListener("pointermove", (event) => {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (activePointers.size === 1 && dragStart) {
    const rect = container.getBoundingClientRect();
    const dx = ((event.clientX - dragStart.x) / rect.width) * dragStart.viewBox.width;
    const dy = ((event.clientY - dragStart.y) / rect.height) * dragStart.viewBox.height;
    totalDragDistance = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
    viewBox.x = dragStart.viewBox.x - dx;
    viewBox.y = dragStart.viewBox.y - dy;
    applyViewBox();
  } else if (activePointers.size === 2 && pinchStartViewBox) {
    const pts = [...activePointers.values()];
    const distance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const scale = pinchStartDistance / Math.max(distance, 1);
    const center = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const rect = container.getBoundingClientRect();
    const focalX = pinchStartViewBox.x + ((center.x - rect.left) / rect.width) * pinchStartViewBox.width;
    const focalY = pinchStartViewBox.y + ((center.y - rect.top) / rect.height) * pinchStartViewBox.height;
    viewBox.width = pinchStartViewBox.width * scale;
    viewBox.height = pinchStartViewBox.height * scale;
    clampViewBox();
    viewBox.x = focalX - ((center.x - rect.left) / rect.width) * viewBox.width;
    viewBox.y = focalY - ((center.y - rect.top) / rect.height) * viewBox.height;
    applyViewBox();
  }
});

function endPointer(/** @type {PointerEvent} */ event) {
  activePointers.delete(event.pointerId);
  if (activePointers.size === 0) {
    dragStart = null;
    pinchStartViewBox = null;
  }
}
container.addEventListener("pointerup", endPointer);
container.addEventListener("pointercancel", endPointer);

container.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const zoomFactor = Math.exp(event.deltaY * 0.001);
    const focal = svgPointFromClient(event.clientX, event.clientY);
    viewBox.width *= zoomFactor;
    viewBox.height *= zoomFactor;
    clampViewBox();
    const rect = container.getBoundingClientRect();
    const fracX = (event.clientX - rect.left) / rect.width;
    const fracY = (event.clientY - rect.top) / rect.height;
    viewBox.x = focal.x - fracX * viewBox.width;
    viewBox.y = focal.y - fracY * viewBox.height;
    applyViewBox();
  },
  { passive: false },
);

// --- tap/click to inspect (a drag longer than this threshold isn't a tap) --- //

const TAP_THRESHOLD_PX = 8;
let selected = /** @type {SVGElement | null} */ (null);

function describe(/** @type {string} */ sal_code) {
  const info = sal_codeToName.get(sal_code);
  if (!info) return null;
  const dc = nameToDataCenter.get(info.name);
  const lines = [];
  if (dc) lines.push(`${dc.tier} data center — ${dc.tflops} TFLOPS`);
  const currentEntry = mapData.spawn_table_by_lobby_size[sizeSelect.value];
  if (currentEntry?.spawns.includes(info.name)) lines.push(`Spawn candidate (${sizeSelect.value}-player preview)`);
  if (info.is_remainder) lines.push("Wilderness — ownable, no data center or spawn");
  return { name: cleanLabel(info.name), lines };
}

function showTooltip(/** @type {string} */ sal_code, /** @type {number} */ clientX, /** @type {number} */ clientY) {
  const info = describe(sal_code);
  if (!info) {
    tooltip.hidden = true;
    return;
  }
  const rect = container.getBoundingClientRect();
  tooltip.style.left = `${clientX - rect.left}px`;
  tooltip.style.top = `${clientY - rect.top}px`;
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

container.addEventListener("click", (event) => {
  if (totalDragDistance > TAP_THRESHOLD_PX) return; // was a pan, not a tap
  // event.target is unreliable here: pointerdown calls setPointerCapture on
  // `container` for panning, which retargets the synthesized click's target
  // to the capturing element instead of whatever's visually under the
  // pointer. Hit-test by coordinate instead.
  const hit = /** @type {SVGElement | null} */ (document.elementFromPoint(event.clientX, event.clientY));
  const sal_code = hit?.dataset?.salCode;
  if (selected) selected.classList.remove("selected");
  if (!sal_code) {
    tooltip.hidden = true;
    selected = null;
    return;
  }
  const path = suburbsLayer.querySelector(`[data-sal-code="${CSS.escape(sal_code)}"]`);
  if (path) {
    path.classList.add("selected");
    selected = /** @type {SVGElement} */ (path);
  }
  showTooltip(sal_code, event.clientX, event.clientY);
});
