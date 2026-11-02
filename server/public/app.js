// @ts-check
// Plain ES module — the server has no build step and browsers can't run
// TypeScript, so this stays hand-written JS rather than introducing a
// bundler for a GUI this small. Typed against server/protocol.ts via JSDoc
// so `pnpm typecheck` still catches a drifted message shape.
//
// Four screens, hash-routed (#/home, #/browse, #/lobby/<id>, #/options) so
// no server routing changes are needed and a lobby's URL is shareable.
/** @typedef {import("../protocol.ts").ServerMessage} ServerMessage */
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").LobbyState} LobbyState */
/** @typedef {import("../protocol.ts").LobbySummary} LobbySummary */

const TOKEN_KEY = "infrastructure-siege:token";
const NAME_KEY = "infrastructure-siege:name";

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
function loadName() {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}
function saveName(/** @type {string} */ name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // nothing to do
  }
}

const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));

const screens = {
  home: /** @type {HTMLElement} */ (document.getElementById("home-screen")),
  browse: /** @type {HTMLElement} */ (document.getElementById("browse-screen")),
  lobby: /** @type {HTMLElement} */ (document.getElementById("lobby-screen")),
  options: /** @type {HTMLElement} */ (document.getElementById("options-screen")),
};

// Home
const callsignInput = /** @type {HTMLInputElement} */ (document.getElementById("callsign"));
const continueButton = /** @type {HTMLButtonElement} */ (document.getElementById("continue-button"));
const browseButton = /** @type {HTMLButtonElement} */ (document.getElementById("browse-button"));
const optionsButton = /** @type {HTMLButtonElement} */ (document.getElementById("options-button"));
const homeErrorEl = /** @type {HTMLElement} */ (document.getElementById("home-error"));

// Browse
const lobbyListEl = /** @type {HTMLElement} */ (document.getElementById("lobby-list"));
const createLobbyForm = /** @type {HTMLFormElement} */ (document.getElementById("create-lobby-form"));
const lobbyNameInput = /** @type {HTMLInputElement} */ (document.getElementById("lobby-name"));
const lobbyCapacityInput = /** @type {HTMLInputElement} */ (document.getElementById("lobby-capacity"));
const browseErrorEl = /** @type {HTMLElement} */ (document.getElementById("browse-error"));

// Lobby
const lobbyNameDisplayEl = /** @type {HTMLElement} */ (document.getElementById("lobby-name-display"));
const playerCountEl = /** @type {HTMLElement} */ (document.getElementById("player-count"));
const lobbyStatusEl = /** @type {HTMLElement} */ (document.getElementById("lobby-status"));
const startButton = /** @type {HTMLButtonElement} */ (document.getElementById("start-button"));
const countEl = /** @type {HTMLElement} */ (document.getElementById("count"));
const lastBumpedByEl = /** @type {HTMLElement} */ (document.getElementById("last-bumped-by"));
const bumpButton = /** @type {HTMLButtonElement} */ (document.getElementById("bump-button"));
const playerListEl = /** @type {HTMLElement} */ (document.getElementById("player-list"));

/** @type {WebSocket | null} */
let socket = null;
let reconnectAttempt = 0;

let registered = false;
/** @type {string | null} */
let myPlayerId = null;
/** @type {string | null} */
let myName = null;
/** @type {LobbyState | null} */
let currentLobby = null;
/** @type {LobbySummary[]} */
let lobbies = [];
/** @type {string | null} */
let pendingNavigateTo = null;
let navigateOnNextLobbyState = false;
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

function showScreen(/** @type {"home" | "browse" | "lobby" | "options"} */ name) {
  for (const key of /** @type {const} */ (["home", "browse", "lobby", "options"])) {
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
  countEl.textContent = String(lobby.count);
  lastBumpedByEl.textContent = lobby.lastBumpedBy ?? "nobody yet";
  lobbyStatusEl.textContent = lobby.started ? "started" : "waiting";
  lobbyStatusEl.dataset.state = lobby.started ? "started" : "waiting";
  startButton.hidden = lobby.started;

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

function render() {
  const route = parseHash();

  if (currentScreenName === "browse" && route.screen !== "browse") {
    send({ type: "unwatchLobbies" });
  }

  if (route.screen === "browse") {
    if (!registered) {
      // A returning visitor's `hello` round-trip hasn't resolved yet if
      // this fires on initial page load (e.g. a bookmarked #/browse URL) —
      // capture the destination so render() continues here once `welcome`
      // arrives, same as the shared-lobby-link case below.
      pendingNavigateTo = location.hash;
      location.hash = "#/home";
      return;
    }
    showScreen("browse");
    send({ type: "watchLobbies" });
    renderLobbyList();
  } else if (route.screen === "lobby") {
    if (!registered) {
      // Supports a shared lobby link: capture it, send the visitor to
      // register on Home first, then rejoin this route once they have.
      pendingNavigateTo = location.hash;
      location.hash = "#/home";
      return;
    }
    showScreen("lobby");
    if (!currentLobby || currentLobby.lobbyId !== route.lobbyId) {
      send({ type: "joinLobby", lobbyId: route.lobbyId });
    } else {
      renderLobbyScreen(currentLobby);
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
    callsignInput.disabled = true;
    bumpButton.disabled = false;

    if (pendingNavigateTo) {
      const target = pendingNavigateTo;
      pendingNavigateTo = null;
      location.hash = target;
    } else {
      render();
    }
  } else if (msg.type === "lobbyState") {
    currentLobby = msg.lobby;
    if (navigateOnNextLobbyState) {
      navigateOnNextLobbyState = false;
      location.hash = `#/lobby/${encodeURIComponent(msg.lobby.lobbyId)}`;
    } else {
      const route = parseHash();
      if (route.screen === "lobby" && route.lobbyId === msg.lobby.lobbyId) {
        renderLobbyScreen(msg.lobby);
      } else if (route.screen === "home") {
        updateContinueButton();
      }
    }
  } else if (msg.type === "lobbyList") {
    lobbies = msg.lobbies;
    if (parseHash().screen === "browse") renderLobbyList();
  } else if (msg.type === "error") {
    navigateOnNextLobbyState = false;
    location.hash = "#/browse";
    showError(browseErrorEl, msg.message);
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
    // The server resumes identity from the stored token (if any) and
    // rejects any action before 'hello' (1008), so a reconnect has to
    // re-announce itself exactly like a first connection would.
    if (myName) {
      send({ type: "hello", name: myName, token: loadToken() ?? undefined });
    }
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    if (!myName) return; // closed before ever registering — don't auto-retry
    setStatus("disconnected");
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000);
    reconnectAttempt += 1;
    setTimeout(connect, delay);
  });
}

function registerWith(/** @type {string} */ name) {
  myName = name;
  saveName(name);
  send({ type: "hello", name, token: loadToken() ?? undefined });
}

continueButton.addEventListener("click", () => {
  if (currentLobby) location.hash = `#/lobby/${encodeURIComponent(currentLobby.lobbyId)}`;
});

browseButton.addEventListener("click", () => {
  clearError(homeErrorEl);
  if (registered) {
    location.hash = "#/browse";
    return;
  }
  const name = callsignInput.value.trim();
  if (!name) {
    showError(homeErrorEl, "enter a callsign first");
    return;
  }
  // If a shared lobby link sent an unregistered visitor to Home first (see
  // render()'s "lobby" branch), that link is already waiting in
  // pendingNavigateTo — registering should return them to it, not silently
  // reroute to Browse and drop the lobby they actually followed a link to.
  pendingNavigateTo ??= "#/browse";
  registerWith(name);
});

optionsButton.addEventListener("click", () => {
  location.hash = "#/options";
});

createLobbyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearError(browseErrorEl);
  const name = lobbyNameInput.value.trim();
  const capacity = Number(lobbyCapacityInput.value);
  if (!name) return;
  navigateOnNextLobbyState = true;
  send({ type: "createLobby", name, capacity });
});

startButton.addEventListener("click", () => {
  send({ type: "startLobby" });
});

bumpButton.addEventListener("click", () => {
  send({ type: "bump" });
});

window.addEventListener("hashchange", render);

// A returning visitor (token + name already saved) is silently resumed on
// load — `welcome`'s lobby then enables Continue via updateContinueButton().
const storedToken = loadToken();
const storedName = loadName();
if (storedToken && storedName) {
  myName = storedName;
  callsignInput.value = storedName;
}

connect();
render();
