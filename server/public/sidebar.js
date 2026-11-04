// @ts-check
// Sidebar overlay (ANU-020): Territory/Units/Factories tabs replacing the
// old standalone "Players" panel below a boxed map. Dependency-injected
// (takes `{ send }`) rather than importing app.js, preserving the existing
// one-directional import shape (app.js -> map.js/sidebar.js). Plain JS +
// JSDoc, same convention as map.js/app.js — browsers can't run TypeScript
// and there's no bundler.
//
// GUI boundary (issues/ANU-013.md's Notes, overridden for units/factories
// specifically per issues/ANU-020.md's Why): moveUnit/attackSuburb/
// buildFactory get real controls here. No control exists for placeUnit (a
// free-unit-anywhere primitive that predates the scrap economy), queueUnit
// (removed by ANU-022 — units auto-produce on a timer, not a player-picked
// queue; the factory panel now just shows read-only per-type progress), or
// zone capture (out of scope). ANU-029 adds the Research tab: a real
// startResearch control for the skill tree.
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").LobbyState} LobbyState */
/** @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit */
/** @typedef {import("../protocol.ts").FactoryState} FactoryState */
/** @typedef {import("../protocol.ts").UnitTypeCatalogEntry} UnitTypeCatalogEntry */
/** @typedef {import("./map.js").MapSelection} MapSelection */
import { suburbDetailViewModel } from "./suburb-detail-view.js";
import { skillTreeVisual } from "./skill-tree-visual.js";
import { SKILL_NODES } from "./skill-tree-nodes.js";
export { suburbDetailViewModel };

/**
 * @typedef {object} SidebarState
 * @property {LobbyState} lobby
 * @property {string} myPlayerId
 * @property {OccupantUnit[]} occupancy
 * @property {FactoryState[]} factories
 * @property {UnitTypeCatalogEntry[]} unitCatalog
 * @property {{scrap: number, tflops: number}} economy
 * @property {SkillTreeState | null} skillTree - null until the first
 *   `skillTree` message arrives.
 */

/**
 * The parts of the server's `skillTree` message the Research tab needs.
 * @typedef {object} SkillTreeState
 * @property {string[]} unlockedNodeIds
 * @property {import("./skill-tree-visual.js").ResearchingState | null} researching
 */

const sidebarEl = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
const handleEl = /** @type {HTMLButtonElement} */ (document.getElementById("sidebar-handle"));
const tabsEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-tabs"));
const economyEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-economy"));
const scrapEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-scrap"));
const tflopsEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-tflops"));
const panels = {
  territory: /** @type {HTMLElement} */ (document.getElementById("panel-territory")),
  units: /** @type {HTMLElement} */ (document.getElementById("panel-units")),
  factories: /** @type {HTMLElement} */ (document.getElementById("panel-factories")),
  research: /** @type {HTMLElement} */ (document.getElementById("panel-research")),
};
const suburbDetailEl = /** @type {HTMLElement} */ (document.getElementById("suburb-detail"));
const unitListEl = /** @type {HTMLElement} */ (document.getElementById("unit-list"));
const factoryListEl = /** @type {HTMLElement} */ (document.getElementById("factory-list"));
const skillTreeListEl = /** @type {HTMLElement} */ (document.getElementById("skill-tree-list"));

/** @typedef {"territory" | "units" | "factories" | "research"} SidebarTab */

/** @type {(message: Record<string, unknown>) => void} */
let send = () => {};

/** @type {SidebarState | null} */
let currentState = null;
/** @type {MapSelection} */
let currentSelection = null;
/** @type {SidebarTab} */
let activeTab = "territory";
/**
 * The last-rendered skill tree's node states (everything except progress).
 * State arrives every ~1s; rebuilding the list each time would replace the
 * Research button between a press and its release and drop the click, so the
 * list is only rebuilt when this changes. Otherwise just the progress bar
 * is updated in place.
 */
let skillTreeSignature = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;

function unitTypeLabel(/** @type {string} */ key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function showTab(/** @type {SidebarTab} */ tab) {
  activeTab = tab;
  for (const [name, el] of Object.entries(panels)) el.hidden = name !== tab;
  for (const button of tabsEl.querySelectorAll(".sidebar-tab")) {
    button.setAttribute("aria-current", String(button.getAttribute("data-panel") === tab));
  }
}

/**
 * Read-only per-type production progress for one factory (ANU-022) — no
 * control here triggers anything; a factory auto-produces every buildable
 * type on its own timer with no player choice, so this just reflects
 * FactoryState.production unchanged (via factoryVisual's pass-through).
 * @param {import("../protocol.ts").FactoryProductionCycle[]} production
 */
function buildProductionDisplay(production) {
  const wrap = document.createElement("div");
  wrap.className = "suburb-detail__actions";
  for (const cycle of production) {
    const row = document.createElement("div");
    row.className = "roster-list__progress-row";
    const label = document.createElement("span");
    label.textContent = unitTypeLabel(cycle.unitTypeKey);
    row.appendChild(label);
    const progress = document.createElement("div");
    progress.className = "roster-list__progress";
    const fill = document.createElement("div");
    fill.className = "roster-list__progress-fill";
    fill.style.width = `${Math.round(cycle.progressFraction * 100)}%`;
    progress.appendChild(fill);
    row.appendChild(progress);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderSuburbDetail() {
  suburbDetailEl.replaceChildren();
  if (!currentState || !currentSelection || currentSelection.type !== "suburb") return;
  const { lobby, occupancy, factories, myPlayerId } = currentState;
  const sal_code = currentSelection.sal_code;
  const detail = suburbDetailViewModel({ sal_code, ownership: lobby.ownership, occupancy, factories, members: lobby.members, myPlayerId });

  const name = document.createElement("p");
  name.className = "suburb-detail__name";
  name.textContent = sal_code;
  suburbDetailEl.appendChild(name);

  const owner = document.createElement("p");
  owner.className = "suburb-detail__owner";
  const dot = document.createElement("span");
  dot.className = "suburb-detail__owner-dot";
  if (detail.ownerColor) dot.style.background = detail.ownerColor;
  owner.appendChild(dot);
  owner.appendChild(document.createTextNode(detail.ownerName ? `Owned by ${detail.ownerName}` : "Unclaimed"));
  suburbDetailEl.appendChild(owner);

  if (detail.occupants.length > 0) {
    const occupantsList = document.createElement("ul");
    occupantsList.className = "roster-list";
    for (const unit of detail.occupants) {
      const li = document.createElement("li");
      const ownerMember = lobby.members.find((m) => m.playerId === unit.ownerPlayerId);
      li.textContent = `${unitTypeLabel(unit.unitTypeKey)} — ${ownerMember?.name ?? "unknown"} (${unit.health} hp)`;
      occupantsList.appendChild(li);
    }
    suburbDetailEl.appendChild(occupantsList);
  }

  const actions = document.createElement("div");
  actions.className = "suburb-detail__actions";

  if (detail.canBuildFactory) {
    const build = document.createElement("button");
    build.type = "button";
    build.textContent = "Build factory";
    build.addEventListener("click", () => send({ type: "buildFactory", sal_code }));
    actions.appendChild(build);
  }

  if (detail.factory) {
    const factoryLine = document.createElement("p");
    const factoryOwner = lobby.members.find((m) => m.playerId === detail.factory?.ownerPlayerId);
    factoryLine.textContent = `Factory (${factoryOwner?.name ?? "unknown"})`;
    actions.appendChild(factoryLine);
    if (detail.factory.ownerPlayerId === myPlayerId) {
      actions.appendChild(buildProductionDisplay(detail.factory.production));
    }
  }

  if (detail.sendableUnits.length > 0) {
    const picker = document.createElement("select");
    for (const unit of detail.sendableUnits) {
      const option = document.createElement("option");
      option.value = unit.id;
      option.textContent = `${unitTypeLabel(unit.unitTypeKey)} @ ${unit.sal_code}`;
      picker.appendChild(option);
    }
    const sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.textContent = "Send unit here";
    sendButton.addEventListener("click", () => send({ type: "attackSuburb", unitId: picker.value, sal_code }));
    actions.appendChild(picker);
    actions.appendChild(sendButton);
  }

  suburbDetailEl.appendChild(actions);
}

function renderUnitList() {
  if (!currentState) return;
  const { occupancy, myPlayerId } = currentState;
  const mine = occupancy.filter((u) => u.ownerPlayerId === myPlayerId);
  if (mine.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No units yet.";
    unitListEl.replaceChildren(empty);
    return;
  }
  unitListEl.replaceChildren(
    ...mine.map((unit) => {
      const li = document.createElement("li");
      if (currentSelection?.type === "unit" && currentSelection.unitId === unit.id) li.classList.add("highlighted");
      li.textContent = `${unitTypeLabel(unit.unitTypeKey)} @ ${unit.sal_code} (${unit.health} hp)`;
      return li;
    }),
  );
}

function renderFactoryList() {
  if (!currentState) return;
  const { factories, myPlayerId } = currentState;
  const mine = factories.filter((f) => f.ownerPlayerId === myPlayerId);
  if (mine.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No factories yet.";
    factoryListEl.replaceChildren(empty);
    return;
  }
  factoryListEl.replaceChildren(
    ...mine.map((factory) => {
      const li = document.createElement("li");
      if (currentSelection?.type === "factory" && currentSelection.factoryId === factory.id) {
        li.classList.add("highlighted");
      }
      const location = document.createElement("span");
      location.textContent = `Factory @ ${factory.sal_code}`;
      li.appendChild(location);
      li.appendChild(buildProductionDisplay(factory.production));
      return li;
    }),
  );
}

const NODE_NAMES = new Map(SKILL_NODES.map((n) => [n.id, n.name]));

/**
 * @param {string} src
 * @param {string} className
 */
function pixelIcon(src, className) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.width = 32;
  img.height = 32;
  img.className = className;
  return img;
}

/** @param {import("./skill-tree-visual.js").SkillNodeVisual} node */
function buildSkillNode(node) {
  const li = document.createElement("li");
  li.className = "skill-node";
  li.dataset.nodeId = node.id;
  if (node.prerequisiteId) li.classList.add("skill-node--child");
  if (node.unlocked) li.classList.add("skill-node--unlocked");
  else if (node.researching) li.classList.add("skill-node--researching");
  else if (node.purchasable) li.classList.add("skill-node--available");
  else li.classList.add("skill-node--locked");

  const header = document.createElement("div");
  header.className = "skill-node__header";
  header.appendChild(pixelIcon(node.icon, "skill-node__icon"));
  const text = document.createElement("div");
  text.className = "skill-node__text";
  const name = document.createElement("span");
  name.className = "skill-node__name";
  name.textContent = node.name;
  const description = document.createElement("span");
  description.className = "skill-node__description";
  description.textContent = node.description;
  text.append(name, description);
  header.appendChild(text);
  if (node.unlocked) {
    const badge = document.createElement("span");
    badge.className = "skill-node__badge";
    badge.textContent = "Unlocked";
    header.appendChild(badge);
  }
  li.appendChild(header);

  if (!node.effectLive) {
    const note = document.createElement("p");
    note.className = "skill-node__note";
    note.textContent = "No in-game effect yet.";
    li.appendChild(note);
  }

  if (node.researching) {
    const row = document.createElement("div");
    row.className = "roster-list__progress-row";
    row.appendChild(pixelIcon("icons/skills/researching.png", "skill-node__progress-icon"));
    const progress = document.createElement("div");
    progress.className = "roster-list__progress";
    const fill = document.createElement("div");
    fill.className = "roster-list__progress-fill";
    progress.appendChild(fill);
    const pct = document.createElement("span");
    pct.className = "skill-node__pct";
    row.append(progress, pct);
    li.appendChild(row);
  } else if (node.purchasable) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "skill-node__research";
    button.textContent = "Research";
    button.addEventListener("click", () => {
      button.disabled = true; // the next skillTree message re-renders; this just stops a double send
      send({ type: "startResearch", nodeId: node.id });
    });
    li.appendChild(button);
  } else if (node.lockedReason) {
    const reason = document.createElement("p");
    reason.className = "skill-node__locked-reason";
    reason.textContent =
      node.lockedReason === "prerequisite"
        ? `Requires ${NODE_NAMES.get(node.prerequisiteId ?? "") ?? node.prerequisiteId}`
        : "Another project is in progress";
    li.appendChild(reason);
  }
  return li;
}

function renderSkillTree() {
  if (!currentState) return;
  const tree = currentState.skillTree;
  const { nodes } = skillTreeVisual({ unlockedNodeIds: tree?.unlockedNodeIds ?? [], researching: tree?.researching ?? null });
  const signature = nodes
    .map((n) => `${n.id}:${n.unlocked ? "u" : n.researching ? "r" : n.purchasable ? "p" : n.lockedReason}`)
    .join("|");
  if (signature !== skillTreeSignature) {
    skillTreeSignature = signature;
    skillTreeListEl.replaceChildren(...nodes.map(buildSkillNode));
  }
  const researching = nodes.find((n) => n.researching);
  if (!researching) return;
  const li = skillTreeListEl.querySelector(`[data-node-id="${CSS.escape(researching.id)}"]`);
  const fill = /** @type {HTMLElement | null} */ (li?.querySelector(".roster-list__progress-fill") ?? null);
  const pct = li?.querySelector(".skill-node__pct");
  const percent = Math.floor((researching.progressFraction ?? 0) * 100);
  if (fill) fill.style.width = `${percent}%`;
  if (pct) pct.textContent = `${percent}%`;
}

/**
 * ANU-029: a rejected in-game action (the server's `error` message) shown
 * at the top of the sidebar for a few seconds, instead of app.js's
 * pre-game handling (redirect to Browse).
 * @param {string} message
 */
export function showSidebarError(message) {
  let el = /** @type {HTMLElement | null} */ (sidebarEl.querySelector(".sidebar-error"));
  if (!el) {
    el = document.createElement("p");
    el.className = "sidebar-error";
    el.setAttribute("role", "alert");
    economyEl.after(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(errorTimer);
  const shown = el;
  errorTimer = setTimeout(() => {
    shown.hidden = true;
  }, 5000);
  // A rejected startResearch left its button disabled; force a rebuild.
  skillTreeSignature = "";
  renderSkillTree();
}

/** @param {{ send: (message: Record<string, unknown>) => void }} deps */
export function mountSidebar({ send: sendFn }) {
  send = sendFn;
  for (const button of tabsEl.querySelectorAll(".sidebar-tab")) {
    button.addEventListener("click", () => {
      const panel = /** @type {SidebarTab} */ (button.getAttribute("data-panel"));
      showTab(panel);
    });
  }
  handleEl.addEventListener("click", () => sidebarEl.classList.toggle("sidebar--expanded"));
  showTab("territory");
}

export function unmountSidebar() {
  currentState = null;
  currentSelection = null;
  suburbDetailEl.replaceChildren();
  unitListEl.replaceChildren();
  factoryListEl.replaceChildren();
  skillTreeListEl.replaceChildren();
  skillTreeSignature = "";
  showTab("territory");
}

/** @param {SidebarState} state */
export function updateSidebarState(state) {
  currentState = state;
  tabsEl.hidden = false;
  economyEl.hidden = false;
  handleEl.hidden = false;
  scrapEl.textContent = String(state.economy.scrap);
  tflopsEl.textContent = String(state.economy.tflops);
  renderSuburbDetail();
  renderUnitList();
  renderFactoryList();
  renderSkillTree();
}

/**
 * Called by app.js from map.js's onSelect callback — a tap on a unit/
 * factory icon switches to the matching tab and highlights that row; a
 * suburb tap updates the Territory tab's detail section.
 * @param {MapSelection} selection
 */
export function selectFromMap(selection) {
  currentSelection = selection;
  if (selection?.type === "unit") showTab("units");
  else if (selection?.type === "factory") showTab("factories");
  else showTab("territory");
  renderSuburbDetail();
  renderUnitList();
  renderFactoryList();
}
