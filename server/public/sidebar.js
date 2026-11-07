// @ts-check
// Sidebar overlay (ANU-020): Territory/Units/Factories tabs replacing the
// old standalone "Players" panel below a boxed map. Dependency-injected
// (takes `{ send }`) rather than importing app.js, preserving the existing
// one-directional import shape (app.js -> map.js/sidebar.js). Plain JS +
// JSDoc, same convention as map.js/app.js — browsers can't run TypeScript
// and there's no bundler.
//
// GUI boundary (issues/ANU-013.md's Notes, overridden for units/factories
// specifically per issues/ANU-020.md's Why): moveUnits/buildFactory get real
// controls here. No control exists for placeUnit (a free-unit-anywhere
// primitive that predates the scrap economy), queueUnit (removed by
// ANU-022 — units auto-produce on a timer, not a player-picked queue; the
// factory panel now just shows read-only per-type progress), or zone
// capture (out of scope). ANU-029 adds the Research tab: a real
// startResearch control for the skill tree.
//
// ANU-027 replaces the old one-unit dropdown + "Send unit here" button with
// a Risk-style flow: "Move units" opens a per-type quantity panel at the
// selected (source) suburb, then the next suburb tap on the map is captured
// as the destination (intercepted in selectFromMap below) rather than
// re-selecting the Territory detail panel — `pendingMove` tracks this across
// that gap. A non-owned destination needs an explicit window.confirm (no
// existing modal component in this repo, and building one is out of scope);
// an owned destination, or a re-confirmed drone-only order after a
// robot-unreachable destination greys that row out, sends immediately.
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").LobbyState} LobbyState */
/** @typedef {import("../protocol.ts").OccupantUnit} OccupantUnit */
/** @typedef {import("../protocol.ts").FactoryState} FactoryState */
/** @typedef {import("../protocol.ts").UnitTypeCatalogEntry} UnitTypeCatalogEntry */
/** @typedef {import("./map.js").MapSelection} MapSelection */
import { suburbDetailViewModel, unitsByZone } from "./suburb-detail-view.js";
import { skillTreeVisual } from "./skill-tree-visual.js";
import { SKILL_NODES } from "./skill-tree-nodes.js";
import { groundCanReachSuburb, suburbName } from "./map.js";
export { suburbDetailViewModel };

/**
 * @typedef {object} SidebarState
 * @property {LobbyState} lobby
 * @property {string} myPlayerId
 * @property {OccupantUnit[]} occupancy
 * @property {FactoryState[]} factories
 * @property {UnitTypeCatalogEntry[]} unitCatalog
 * @property {{scrap: number}} economy
 * @property {SkillTreeState | null} skillTree - null until the first
 *   `skillTree` message arrives.
 */

/**
 * The parts of the server's `skillTree` message the Research tab needs.
 * ANU-031: tflops/speedMultiplier live here, not on `economy` — they're a
 * research-speed stat the Research tab reads directly, not a currency
 * figure shown alongside scrap.
 * @typedef {object} SkillTreeState
 * @property {string[]} unlockedNodeIds
 * @property {import("./skill-tree-visual.js").ResearchingState | null} researching
 * @property {number} tflops
 * @property {number} speedMultiplier
 */

const sidebarEl = /** @type {HTMLElement} */ (document.getElementById("sidebar"));
const handleEl = /** @type {HTMLButtonElement} */ (document.getElementById("sidebar-handle"));
const tabsEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-tabs"));
const economyEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-economy"));
const scrapEl = /** @type {HTMLElement} */ (document.getElementById("sidebar-scrap"));
const debugAddScrapEl = /** @type {HTMLButtonElement} */ (document.getElementById("debug-add-scrap"));
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
const skillTreeTflopsEl = /** @type {HTMLElement} */ (document.getElementById("skill-tree-tflops"));
const skillTreeSpeedMultiplierEl = /** @type {HTMLElement} */ (document.getElementById("skill-tree-speed-multiplier"));

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

/**
 * Non-null while the "Move units" quantity panel is open for a given
 * source suburb — the map's next suburb tap (selectFromMap) is captured as
 * the destination instead of updating the Territory detail panel (ANU-027).
 * `counts` holds the player's current per-type quantity picks, clamped to
 * `movableUnitGroups`' per-type cap; `robotsUnreachable` is set once a
 * destination has actually been picked and found unreachable for ground
 * units, which greys the robot row and keeps the panel open rather than
 * sending immediately.
 * @type {{ fromSalCode: string, counts: Record<string, number>, robotsUnreachable: boolean, toSalCode?: string } | null}
 */
let pendingMove = null;

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

/**
 * The ANU-027 "Move units" quantity panel for `fromSalCode`: one row per
 * entry in `movableUnitGroups`, a number input plus -10/-5/+5/+10 steppers,
 * each clamped to [0, that type's count]. `pendingMove.robotsUnreachable`
 * (set once a destination has been picked and found unreachable for ground
 * units) disables the robot row and forces its count to 0, per
 * issues/ANU-027.md's "after destination click" rule.
 * @param {import("./suburb-detail-view.js").MovableUnitGroup[]} movableUnitGroups
 */
function buildMovePanel(movableUnitGroups) {
  const wrap = document.createElement("div");
  wrap.className = "move-panel";

  for (const group of movableUnitGroups) {
    const row = document.createElement("div");
    row.className = "move-panel__row";
    const disabled = group.unitTypeKey === "robot" && pendingMove?.robotsUnreachable === true;
    if (disabled && pendingMove) pendingMove.counts[group.unitTypeKey] = 0;
    const current = pendingMove?.counts[group.unitTypeKey] ?? 0;

    const label = document.createElement("span");
    label.className = "move-panel__label";
    label.textContent = `${unitTypeLabel(group.unitTypeKey)} (${group.count})`;
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = String(group.count);
    input.value = String(current);
    input.disabled = disabled;
    input.className = "move-panel__input";
    input.addEventListener("input", () => {
      if (!pendingMove) return;
      const clamped = Math.max(0, Math.min(group.count, Math.trunc(Number(input.value)) || 0));
      pendingMove.counts[group.unitTypeKey] = clamped;
      input.value = String(clamped);
    });
    row.appendChild(input);

    for (const delta of [-10, -5, 5, 10]) {
      const step = document.createElement("button");
      step.type = "button";
      step.className = "move-panel__step";
      step.textContent = delta > 0 ? `+${delta}` : String(delta);
      step.disabled = disabled;
      step.addEventListener("click", () => {
        if (!pendingMove) return;
        const next = Math.max(0, Math.min(group.count, (pendingMove.counts[group.unitTypeKey] ?? 0) + delta));
        pendingMove.counts[group.unitTypeKey] = next;
        input.value = String(next);
      });
      row.appendChild(step);
    }

    if (disabled) {
      const note = document.createElement("span");
      note.className = "move-panel__note";
      note.textContent = "Can't reach that destination";
      row.appendChild(note);
    }

    wrap.appendChild(row);
  }

  if (pendingMove?.robotsUnreachable && pendingMove.toSalCode) {
    // Robots were greyed out by the destination just picked — the player
    // adjusts drone-only counts here, then confirms explicitly rather than
    // re-tapping the map (issues/ANU-027.md: "the panel stays open ... to
    // confirm drone-only counts or cancel").
    const toSalCode = pendingMove.toSalCode;
    const send_ = document.createElement("button");
    send_.type = "button";
    send_.textContent = `Send to ${suburbName(toSalCode)}`;
    send_.addEventListener("click", () => confirmAndSendPendingMove(toSalCode));
    wrap.appendChild(send_);
  } else {
    const hint = document.createElement("p");
    hint.className = "move-panel__hint";
    hint.textContent = "Tap a destination suburb on the map.";
    wrap.appendChild(hint);
  }

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    pendingMove = null;
    renderSuburbDetail();
  });
  wrap.appendChild(cancel);

  return wrap;
}

/**
 * Sends `pendingMove`'s current counts to `toSalCode`, prompting first if
 * the destination isn't the player's own (ANU-027's misclick guard).
 * @param {string} toSalCode
 */
function confirmAndSendPendingMove(toSalCode) {
  if (!pendingMove || !currentState) return;
  const { lobby, myPlayerId } = currentState;
  const counts = Object.fromEntries(Object.entries(pendingMove.counts).filter(([, count]) => count > 0));
  if (Object.keys(counts).length === 0) return; // nothing selected — stay open rather than send an empty order

  const isOwnedByMe = lobby.ownership[toSalCode] === myPlayerId;
  if (!isOwnedByMe && !window.confirm(`Confirm attack on ${suburbName(toSalCode)}?`)) return;

  send({ type: "moveUnits", fromSalCode: pendingMove.fromSalCode, toSalCode, counts });
  pendingMove = null;
}

/**
 * Fired when a suburb is tapped on the map while the "Move units" panel is
 * open (ANU-027) — the destination for `pendingMove`'s source/counts.
 * Greys the robot row (and re-renders the still-open panel) the first time
 * an unreachable-for-ground destination is picked, rather than sending
 * immediately; a reachable destination (or a drone-only order against an
 * unreachable one) sends right away, with a confirm prompt first if the
 * destination isn't the player's own.
 * @param {string} toSalCode
 */
function handleMoveDestinationPick(toSalCode) {
  if (!pendingMove || !currentState) return;
  const { lobby, myPlayerId } = currentState;
  const owned = new Set(Object.entries(lobby.ownership).filter(([, owner]) => owner === myPlayerId).map(([sal]) => sal));
  const robotCount = pendingMove.counts.robot ?? 0;
  const robotsCanReach = owned.has(toSalCode) || groundCanReachSuburb(owned, toSalCode);

  if (robotCount > 0 && !robotsCanReach) {
    pendingMove.robotsUnreachable = true;
    pendingMove.toSalCode = toSalCode;
    renderSuburbDetail();
    return;
  }

  confirmAndSendPendingMove(toSalCode);
  renderSuburbDetail(); // reflects the cancel/send outcome (panel closed, or still open if the order was empty)
}

function renderSuburbDetail() {
  suburbDetailEl.replaceChildren();
  if (!currentState || !currentSelection || currentSelection.type !== "suburb") return;
  const { lobby, occupancy, factories, myPlayerId } = currentState;
  const sal_code = currentSelection.sal_code;
  const detail = suburbDetailViewModel({ sal_code, ownership: lobby.ownership, occupancy, factories, members: lobby.members, myPlayerId });

  const name = document.createElement("p");
  name.className = "suburb-detail__name";
  name.textContent = suburbName(sal_code);
  suburbDetailEl.appendChild(name);

  const owner = document.createElement("p");
  owner.className = "suburb-detail__owner";
  const dot = document.createElement("span");
  dot.className = "suburb-detail__owner-dot";
  if (detail.ownerColor) dot.style.background = detail.ownerColor;
  owner.appendChild(dot);
  owner.appendChild(document.createTextNode(detail.ownerName ? `Owned by ${detail.ownerName}` : "Unclaimed"));
  suburbDetailEl.appendChild(owner);

  if (detail.occupantGroups.length > 0) {
    // ANU-035: one row per (owner, unit type) with a count, not one row per
    // individual unit — a suburb with dozens of units used to render dozens
    // of identical "Drone — Beno (3 hp)" rows, the same overlap problem
    // ANU-034 already fixed for the map's unit markers. ANU-037: owner name
    // leads each row ("Beno — Drone ×32"), not the unit type.
    const occupantsList = document.createElement("ul");
    occupantsList.className = "roster-list";
    for (const group of detail.occupantGroups) {
      const li = document.createElement("li");
      const ownerMember = lobby.members.find((m) => m.playerId === group.ownerPlayerId);
      li.textContent = `${ownerMember?.name ?? "unknown"} — ${unitTypeLabel(group.unitTypeKey)} ×${group.count}`;
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

  if (pendingMove && pendingMove.fromSalCode === sal_code) {
    actions.appendChild(buildMovePanel(detail.movableUnitGroups));
  } else if (detail.movableUnitGroups.length > 0) {
    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.textContent = "Move units";
    moveButton.addEventListener("click", () => {
      pendingMove = {
        fromSalCode: sal_code,
        counts: Object.fromEntries(detail.movableUnitGroups.map((g) => [g.unitTypeKey, 0])),
        robotsUnreachable: false,
      };
      renderSuburbDetail();
    });
    actions.appendChild(moveButton);
  }

  suburbDetailEl.appendChild(actions);
}

/**
 * ANU-037: one subheading per suburb the player has units in, then one row
 * per unit type at that suburb with a count — replacing the old one-row-
 * per-individual-unit list (the same overlap problem ANU-035 already fixed
 * for the Territory tab's occupant list). No owner name on these rows: this
 * tab only ever shows the viewing player's own units.
 */
function renderUnitList() {
  if (!currentState) return;
  const { occupancy, myPlayerId } = currentState;
  const groups = unitsByZone({ occupancy, myPlayerId });
  if (groups.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No units yet.";
    unitListEl.replaceChildren(empty);
    return;
  }

  /** @type {Map<string, import("./suburb-detail-view.js").UnitsByZoneGroup[]>} */
  const groupsBySalCode = new Map();
  for (const group of groups) {
    const bucket = groupsBySalCode.get(group.sal_code);
    if (bucket) bucket.push(group);
    else groupsBySalCode.set(group.sal_code, [group]);
  }

  const selection = currentSelection;
  const selectedUnit =
    selection && selection.type === "unit" ? (occupancy.find((u) => u.id === selection.unitId) ?? null) : null;

  const rows = [];
  for (const sal_code of [...groupsBySalCode.keys()].sort()) {
    const heading = document.createElement("li");
    heading.className = "roster-list__zone-heading";
    heading.textContent = suburbName(sal_code);
    rows.push(heading);

    const zoneGroups = /** @type {import("./suburb-detail-view.js").UnitsByZoneGroup[]} */ (groupsBySalCode.get(sal_code));
    for (const group of zoneGroups.sort((a, b) => a.unitTypeKey.localeCompare(b.unitTypeKey))) {
      const li = document.createElement("li");
      if (selectedUnit && selectedUnit.sal_code === group.sal_code && selectedUnit.unitTypeKey === group.unitTypeKey) {
        li.classList.add("highlighted");
      }
      li.textContent = `${unitTypeLabel(group.unitTypeKey)} x${group.count}`;
      rows.push(li);
    }
  }
  unitListEl.replaceChildren(...rows);
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
      location.textContent = `Factory @ ${suburbName(factory.sal_code)}`;
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
  // ANU-031: live TFLOPS and the speed multiplier it produces, shown
  // regardless of whether anything is currently researching.
  skillTreeTflopsEl.textContent = String(tree?.tflops ?? 0);
  skillTreeSpeedMultiplierEl.textContent = (tree?.speedMultiplier ?? 1).toFixed(1);
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
  debugAddScrapEl.addEventListener("click", () => send({ type: "debugAddScrap" }));
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
  renderSuburbDetail();
  renderUnitList();
  renderFactoryList();
  renderSkillTree();
}

/**
 * Called by app.js from map.js's onSelect callback — a tap on a unit/
 * factory icon switches to the matching tab and highlights that row; a
 * suburb tap updates the Territory tab's detail section.
 *
 * ANU-027: while the "Move units" panel is open (`pendingMove` set), a tap
 * on a DIFFERENT suburb is captured as that order's destination instead of
 * changing the Territory selection — re-tapping the source suburb itself
 * just keeps editing it (handled by renderSuburbDetail's own
 * `pendingMove.fromSalCode === sal_code` check). Tapping a unit/factory
 * icon, or deselecting, cancels the pending move — the player has
 * navigated away from "pick a destination" mode.
 * @param {MapSelection} selection
 */
export function selectFromMap(selection) {
  if (pendingMove) {
    if (selection?.type === "suburb" && selection.sal_code !== pendingMove.fromSalCode) {
      handleMoveDestinationPick(selection.sal_code);
      return;
    }
    if (selection?.type !== "suburb") pendingMove = null;
  }

  currentSelection = selection;
  if (selection?.type === "unit") showTab("units");
  else if (selection?.type === "factory") showTab("factories");
  else showTab("territory");
  renderSuburbDetail();
  renderUnitList();
  renderFactoryList();
}
