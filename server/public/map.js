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
//
// Coordinate math goes through the SVG's own getScreenCTM(), not container
// getBoundingClientRect() fractions: the urban viewBox is portrait while the
// desktop container is landscape, so preserveAspectRatio="meet" letterboxes
// the rendered map inside the container — a client-rect-fraction mapping is
// wrong by exactly the letterbox gap, in whichever axis is boxed. The CTM
// already encodes the real scale/offset the browser is using, independent
// of which axis ends up letterboxed at a given viewport size.

let viewBox = { ...geometry.urban_view_box };
const fullBounds = geometry.full_view_box;

function applyViewBox() {
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
}
applyViewBox();

// Keep at least a sliver of the map on screen; don't let pan/zoom lose the
// board entirely. Width/height stay bounded between a close-in zoom and the
// full map extent, with the aspect ratio always matching urban_view_box's —
// that invariant is what keeps the rendered-map size in CSS px constant
// across zoom levels (see zoomAroundClientPoint), not just incidental.
function clampedDims(/** @type {number} */ width) {
  const minW = fullBounds.width / 20;
  const maxW = fullBounds.width * 1.5;
  const clampedWidth = Math.min(maxW, Math.max(minW, width));
  const clampedHeight = clampedWidth * (geometry.urban_view_box.height / geometry.urban_view_box.width);
  return { width: clampedWidth, height: clampedHeight };
}

/**
 * @param {number} clientX
 * @param {number} clientY
 */
function clientToSvgPoint(clientX, clientY) {
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: clientX, y: clientY }; // no layout yet — shouldn't happen once the page has rendered
  const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: pt.x, y: pt.y };
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
let pinchStartHeight = 0;
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
    pinchStartHeight = viewBox.height;
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
