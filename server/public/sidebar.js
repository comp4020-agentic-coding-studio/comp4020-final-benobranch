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
// buildFactory/queueUnit get real controls here. No control exists for
// placeUnit (a free-unit-anywhere primitive that predates the scrap
// economy) and none for the skill tree or zone capture (out of scope).
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").LobbyState} LobbyState */
/** @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit */
/** @typedef {import("../protocol.ts").FactoryState} FactoryState */
/** @typedef {import("../protocol.ts").UnitTypeCatalogEntry} UnitTypeCatalogEntry */
/** @typedef {import("./map.js").MapSelection} MapSelection */
import { suburbDetailViewModel } from "./suburb-detail-view.js";
export { suburbDetailViewModel };

/**
 * @typedef {object} SidebarState
 * @property {LobbyState} lobby
 * @property {string} myPlayerId
 * @property {OccupantUnit[]} occupancy
 * @property {FactoryState[]} factories
 * @property {UnitTypeCatalogEntry[]} unitCatalog
 * @property {{scrap: number, tflops: number}} economy
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
};
const suburbDetailEl = /** @type {HTMLElement} */ (document.getElementById("suburb-detail"));
const unitListEl = /** @type {HTMLElement} */ (document.getElementById("unit-list"));
const factoryListEl = /** @type {HTMLElement} */ (document.getElementById("factory-list"));

/** @type {(message: Record<string, unknown>) => void} */
let send = () => {};

/** @type {SidebarState | null} */
let currentState = null;
/** @type {MapSelection} */
let currentSelection = null;
/** @type {"territory" | "units" | "factories"} */
let activeTab = "territory";

function unitTypeLabel(/** @type {string} */ key) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function showTab(/** @type {"territory" | "units" | "factories"} */ tab) {
  activeTab = tab;
  for (const [name, el] of Object.entries(panels)) el.hidden = name !== tab;
  for (const button of tabsEl.querySelectorAll(".sidebar-tab")) {
    button.setAttribute("aria-current", String(button.getAttribute("data-panel") === tab));
  }
}

/**
 * @param {string} factoryId
 * @param {UnitTypeCatalogEntry[]} unitCatalog
 * @param {number} scrap
 */
function buildQueueControls(factoryId, unitCatalog, scrap) {
  const wrap = document.createElement("div");
  wrap.className = "suburb-detail__actions";
  for (const unitType of unitCatalog) {
    if (unitType.requiresSkillNode) continue; // not unlockable from this GUI yet — see issues/ANU-020.md
    const button = document.createElement("button");
    button.type = "button";
    const affordable = scrap >= unitType.buildCostScrap;
    button.disabled = !affordable;
    button.textContent = `Build ${unitTypeLabel(unitType.key)} (${unitType.buildCostScrap} scrap)`;
    button.addEventListener("click", () => send({ type: "queueUnit", factoryId, unitTypeKey: unitType.key }));
    wrap.appendChild(button);
  }
  return wrap;
}

function renderSuburbDetail() {
  suburbDetailEl.replaceChildren();
  if (!currentState || !currentSelection || currentSelection.type !== "suburb") return;
  const { lobby, occupancy, factories, unitCatalog, economy, myPlayerId } = currentState;
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
    factoryLine.textContent = `Factory (${factoryOwner?.name ?? "unknown"})${
      detail.factory.queuedUnitTypeKey ? ` — building ${unitTypeLabel(detail.factory.queuedUnitTypeKey)}` : ""
    }`;
    actions.appendChild(factoryLine);
    if (detail.canQueueUnit) {
      actions.appendChild(buildQueueControls(detail.factory.id, unitCatalog, economy.scrap));
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
  const { factories, unitCatalog, economy, myPlayerId } = currentState;
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
      if (factory.queuedUnitTypeKey && factory.queueProgressFraction !== null) {
        const progress = document.createElement("div");
        progress.className = "roster-list__progress";
        const fill = document.createElement("div");
        fill.className = "roster-list__progress-fill";
        fill.style.width = `${Math.round(factory.queueProgressFraction * 100)}%`;
        progress.appendChild(fill);
        li.appendChild(progress);
      } else {
        li.appendChild(buildQueueControls(factory.id, unitCatalog, economy.scrap));
      }
      return li;
    }),
  );
}

/** @param {{ send: (message: Record<string, unknown>) => void }} deps */
export function mountSidebar({ send: sendFn }) {
  send = sendFn;
  for (const button of tabsEl.querySelectorAll(".sidebar-tab")) {
    button.addEventListener("click", () => {
      const panel = /** @type {"territory" | "units" | "factories"} */ (button.getAttribute("data-panel"));
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
