// @ts-check
// Plain ES module — the server has no build step and browsers can't run
// TypeScript, so this stays hand-written JS rather than introducing a
// bundler for a GUI this small. Typed against server/protocol.ts via JSDoc
// so `pnpm typecheck` still catches a drifted message shape.
//
// Five screens: Home, Browse, Lobby, Options (hash-routed: #/home, #/browse,
// #/lobby/<id>, #/options — no server routing changes, shareable lobby
// URLs) plus a non-routed Name prompt shown inline when the server reports
// `nameRequired` for a lobby this player hasn't joined before (see ADR
// 0002: identity is a device token, but each lobby locks in its own
// callsign the first time a player joins it).
/** @typedef {import("../protocol.ts").ServerMessage} ServerMessage */
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").LobbyState} LobbyState */
/** @typedef {import("../protocol.ts").LobbySummary} LobbySummary */
import { mountMap, unmountMap } from "./map.js";

const TOKEN_KEY = "infrastructure-siege:token";
const LAST_CALLSIGN_KEY = "infrastructure-siege:last-callsign";

function loadToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private browsing / blocked storage — fall back to a fresh identity every load
  }
}
function saveToken(/** @type {string} */ token) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // nothing to do — this session just won't resume next load
  }
}
function loadLastCallsign() {
  try {
    return localStorage.getItem(LAST_CALLSIGN_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveLastCallsign(/** @type {string} */ callsign) {
  try {
    localStorage.setItem(LAST_CALLSIGN_KEY, callsign);
  } catch {
    // purely a convenience prefill — fine to drop
  }
}

const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));

const screens = {
  home: /** @type {HTMLElement} */ (document.getElementById("home-screen")),
  browse: /** @type {HTMLElement} */ (document.getElementById("browse-screen")),
  lobby: /** @type {HTMLElement} */ (document.getElementById("lobby-screen")),
  options: /** @type {HTMLElement} */ (document.getElementById("options-screen")),
  namePrompt: /** @type {HTMLElement} */ (document.getElementById("name-prompt-screen")),
};

// Home
const continueButton = /** @type {HTMLButtonElement} */ (document.getElementById("continue-button"));
const browseButton = /** @type {HTMLButtonElement} */ (document.getElementById("browse-button"));
const optionsButton = /** @type {HTMLButtonElement} */ (document.getElementById("options-button"));

// Browse
const lobbyListEl = /** @type {HTMLElement} */ (document.getElementById("lobby-list"));
const createLobbyForm = /** @type {HTMLFormElement} */ (document.getElementById("create-lobby-form"));
const lobbyNameInput = /** @type {HTMLInputElement} */ (document.getElementById("lobby-name"));
const lobbyCapacityInput = /** @type {HTMLInputElement} */ (document.getElementById("lobby-capacity"));
const createCallsignInput = /** @type {HTMLInputElement} */ (document.getElementById("create-callsign"));
const browseErrorEl = /** @type {HTMLElement} */ (document.getElementById("browse-error"));

// Name prompt (shown inline when joining a lobby for the first time)
const namePromptLobbyNameEl = /** @type {HTMLElement} */ (document.getElementById("name-prompt-lobby-name"));
const namePromptForm = /** @type {HTMLFormElement} */ (document.getElementById("name-prompt-form"));
const joinCallsignInput = /** @type {HTMLInputElement} */ (document.getElementById("join-callsign"));
const namePromptErrorEl = /** @type {HTMLElement} */ (document.getElementById("name-prompt-error"));

// Lobby
const lobbyNameDisplayEl = /** @type {HTMLElement} */ (document.getElementById("lobby-name-display"));
const playerCountEl = /** @type {HTMLElement} */ (document.getElementById("player-count"));
const lobbyStatusEl = /** @type {HTMLElement} */ (document.getElementById("lobby-status"));
const startButton = /** @type {HTMLButtonElement} */ (document.getElementById("start-button"));
const mapPanelEl = /** @type {HTMLElement} */ (document.getElementById("map-panel"));
const playerListEl = /** @type {HTMLElement} */ (document.getElementById("player-list"));

/** @type {WebSocket | null} */
let socket = null;
let reconnectAttempt = 0;

// True once `welcome` has arrived at least once — the server resolves an
// identity for every connection automatically (from the stored token, or a
// fresh one), so there's no user input gating this, unlike a per-lobby
// callsign.
let registered = false;
/** @type {string | null} */
let myPlayerId = null;
/** @type {LobbyState | null} */
let currentLobby = null;
/** @type {LobbySummary[]} */
let lobbies = [];
let navigateOnNextLobbyState = false;
/**
 * Set when the server has asked for a callsign to join this specific lobby
 * (first join only) — render() shows the name prompt instead of re-sending
 * `joinLobby` in a loop while this is set for the current #/lobby/<id>.
 * @type {string | null}
 */
let awaitingCallsignForLobbyId = null;
/** @type {"home" | "browse" | "lobby" | "options" | null} */
let currentScreenName = null;

function setStatus(/** @type {"connecting" | "connected" | "disconnected"} */ state) {
  statusEl.dataset.state = state;
  statusEl.textContent =
    state === "connecting" ? "Connecting…" : state === "connected" ? "Connected" : "Disconnected — retrying…";
}

function showError(/** @type {HTMLElement} */ el, /** @type {string} */ message) {
  el.textContent = message;
  el.hidden = false;
}
function clearError(/** @type {HTMLElement} */ el) {
  el.hidden = true;
}

function send(/** @type {Record<string, unknown>} */ message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** @returns {{ screen: "home" | "browse" | "lobby" | "options", lobbyId?: string }} */
function parseHash() {
  const hash = location.hash || "#/home";
  const lobbyMatch = hash.match(/^#\/lobby\/(.+)$/);
  if (lobbyMatch) return { screen: "lobby", lobbyId: decodeURIComponent(lobbyMatch[1]) };
  if (hash === "#/browse") return { screen: "browse" };
  if (hash === "#/options") return { screen: "options" };
  return { screen: "home" };
}

function showScreen(/** @type {"home" | "browse" | "lobby" | "options" | "namePrompt"} */ name) {
  for (const key of /** @type {const} */ (["home", "browse", "lobby", "options", "namePrompt"])) {
    screens[key].hidden = key !== name;
  }
}

function updateContinueButton() {
  continueButton.disabled = !currentLobby;
}

function renderLobbyList() {
  if (lobbies.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No lobbies yet — create one below.";
    lobbyListEl.replaceChildren(empty);
    return;
  }
  lobbyListEl.replaceChildren(
    ...lobbies.map((lobby) => {
      const li = document.createElement("li");
      const info = document.createElement("div");
      info.className = "lobby-list__info";
      const nameEl = document.createElement("span");
      nameEl.className = "lobby-list__name";
      nameEl.textContent = lobby.name; // textContent: lobby names are untrusted input
      const metaEl = document.createElement("span");
      metaEl.className = "lobby-list__meta";
      metaEl.textContent = `${lobby.memberCount}/${lobby.capacity} players · ${lobby.onlineCount} online · ${
        lobby.started ? "started" : "waiting"
      }`;
      info.append(nameEl, metaEl);

      const isFull = lobby.memberCount >= lobby.capacity;
      const joinButton = document.createElement("button");
      joinButton.type = "button";
      joinButton.textContent = lobby.started ? "Started" : isFull ? "Full" : "Join";
      joinButton.disabled = lobby.started || isFull;
      joinButton.addEventListener("click", () => {
        location.hash = `#/lobby/${encodeURIComponent(lobby.lobbyId)}`;
      });

      li.append(info, joinButton);
      return li;
    }),
  );
}

function renderLobbyScreen(/** @type {LobbyState} */ lobby) {
  lobbyNameDisplayEl.textContent = lobby.name;
  lobbyStatusEl.textContent = lobby.started ? "started" : "waiting";
  lobbyStatusEl.dataset.state = lobby.started ? "started" : "waiting";
  startButton.hidden = lobby.started;

  // A waiting lobby has nothing to show on the map yet (issues/ANU-011.md) —
  // keep the roster+Start panel only. The screen is widened for a started
  // lobby's map, which isn't usable at Home/Browse's 480px cap.
  screens.lobby.classList.toggle("screen--wide", lobby.started);
  mapPanelEl.hidden = !lobby.started;
  if (lobby.started) {
    // The spawn ring preview must match the spawn table the SERVER actually
    // used to auto-own suburbs at kickoff (issues/ANU-013.md), which is
    // keyed by the real player count at start time, not the lobby's
    // configured capacity — a 12-capacity lobby started with 4 players owns
    // the 4-player ring, not the first 4 entries of the 12-player one.
    // Membership is frozen once started, so lobby.members.length is stable.
    mountMap(lobby.lobbyId, lobby.members.length);
  } else {
    unmountMap();
  }

  const onlineCount = lobby.members.filter((m) => m.online).length;
  playerCountEl.textContent = `${onlineCount} online`;

  playerListEl.replaceChildren(
    ...lobby.members.map((/** @type {PlayerPresence} */ m) => {
      const li = document.createElement("li");
      if (m.playerId === myPlayerId) li.classList.add("self");
      if (!m.online) li.classList.add("offline");
      const dot = document.createElement("span");
      dot.className = "player-list__dot";
      const label = document.createElement("span");
      // textContent, never innerHTML: player/lobby names are untrusted
      // input broadcast to every connected client.
      label.textContent = m.playerId === myPlayerId ? `${m.name} (you)` : m.name;
      li.append(dot, label);
      return li;
    }),
  );
}

function showNamePrompt(/** @type {string} */ lobbyId) {
  awaitingCallsignForLobbyId = lobbyId;
  const cached = lobbies.find((l) => l.lobbyId === lobbyId);
  namePromptLobbyNameEl.textContent = cached ? cached.name : "this lobby";
  joinCallsignInput.value = loadLastCallsign();
  showScreen("namePrompt");
}

function render() {
  const route = parseHash();

  if (currentScreenName === "browse" && route.screen !== "browse") {
    send({ type: "unwatchLobbies" });
  }

  if (!registered) {
    // Identity resolution (the 'hello' round trip) hasn't completed yet —
    // nothing meaningful to show. render() runs again once 'welcome'
    // arrives, at which point `location.hash` (unchanged) drives the
    // actual route — e.g. a direct link to #/lobby/<id> is honoured
    // without any separate "redirect to home first" step, since joining a
    // lobby no longer needs anything collected on Home.
    showScreen("home");
    currentScreenName = null;
    return;
  }

  if (route.screen === "browse") {
    showScreen("browse");
    send({ type: "watchLobbies" });
    renderLobbyList();
  } else if (route.screen === "lobby") {
    const lobbyId = /** @type {string} */ (route.lobbyId);
    if (currentLobby && currentLobby.lobbyId === lobbyId) {
      awaitingCallsignForLobbyId = null;
      showScreen("lobby");
      renderLobbyScreen(currentLobby);
    } else if (awaitingCallsignForLobbyId === lobbyId) {
      showNamePrompt(lobbyId);
    } else {
      // Not (yet known to be) a member — ask the server. It either resumes
      // us straight in (already a member, e.g. a reconnect) or replies
      // `nameRequired` if this is our first time in this lobby.
      send({ type: "joinLobby", lobbyId });
      showScreen("lobby");
    }
  } else if (route.screen === "options") {
    showScreen("options");
  } else {
    showScreen("home");
    updateContinueButton();
  }

  currentScreenName = route.screen;
}

function handleMessage(/** @type {ServerMessage} */ msg) {
  if (msg.type === "welcome") {
    registered = true;
    myPlayerId = msg.playerId;
    saveToken(msg.token);
    currentLobby = msg.lobby;
    // Re-evaluates the current route now that identity (and possibly a
    // resumed lobby) is known — on a reconnect this just refreshes
    // currentLobby-derived UI on whatever screen is already showing.
    render();
  } else if (msg.type === "lobbyState") {
    currentLobby = msg.lobby;
    if (navigateOnNextLobbyState) {
      navigateOnNextLobbyState = false;
      location.hash = `#/lobby/${encodeURIComponent(msg.lobby.lobbyId)}`;
    } else {
      render();
    }
  } else if (msg.type === "lobbyList") {
    lobbies = msg.lobbies;
    if (parseHash().screen === "browse") renderLobbyList();
  } else if (msg.type === "nameRequired") {
    navigateOnNextLobbyState = false;
    showNamePrompt(msg.lobbyId);
  } else if (msg.type === "error") {
    if (awaitingCallsignForLobbyId) {
      // Failed after the player chose a callsign (e.g. it was taken, or the
      // lobby filled/started in the gap) — stay on the prompt and say why.
      showError(namePromptErrorEl, msg.message);
    } else {
      // Failed on a plain join attempt (full/started/gone) — back to
      // Browse, which is where that attempt was made from.
      navigateOnNextLobbyState = false;
      location.hash = "#/browse";
      showError(browseErrorEl, msg.message);
    }
  }
}

function connect() {
  setStatus(registered ? "disconnected" : "connecting");
  const url = `${location.origin.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    setStatus("connected");
    // The server resolves identity from the stored token (if any) with no
    // other input needed — a reconnect re-announces itself exactly like a
    // first connection would.
    send({ type: "hello", token: loadToken() ?? undefined });
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    setStatus("disconnected");
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000);
    reconnectAttempt += 1;
    setTimeout(connect, delay);
  });
}

continueButton.addEventListener("click", () => {
  if (currentLobby) location.hash = `#/lobby/${encodeURIComponent(currentLobby.lobbyId)}`;
});

browseButton.addEventListener("click", () => {
  location.hash = "#/browse";
});

optionsButton.addEventListener("click", () => {
  location.hash = "#/options";
});

createLobbyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError(browseErrorEl);
  const name = lobbyNameInput.value.trim();
  const capacity = Number(lobbyCapacityInput.value);
  const callsign = createCallsignInput.value.trim();
  if (!name || !callsign) return;
  saveLastCallsign(callsign);
  navigateOnNextLobbyState = true;
  send({ type: "createLobby", name, capacity, callsign });
});

namePromptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError(namePromptErrorEl);
  const callsign = joinCallsignInput.value.trim();
  const lobbyId = awaitingCallsignForLobbyId;
  if (!callsign || !lobbyId) return;
  saveLastCallsign(callsign);
  send({ type: "joinLobby", lobbyId, callsign });
});

startButton.addEventListener("click", () => {
  send({ type: "startLobby" });
});

window.addEventListener("hashchange", render);

createCallsignInput.value = loadLastCallsign();

connect();
render();
