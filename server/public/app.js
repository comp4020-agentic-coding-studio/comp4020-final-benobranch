// @ts-check
// Plain ES module — the server has no build step and browsers can't run
// TypeScript, so this stays hand-written JS rather than introducing a
// bundler for a GUI this small. Typed against server/protocol.ts via JSDoc
// so `pnpm typecheck` still catches a drifted message shape.
//
// This is still just the ANU-007 HUD adapted to ANU-008's lobby/identity
// protocol — proving hello/welcome/lobbyState end to end with a token
// persisted across reloads. ANU-009 replaces this with real Home/Browse/HUD
// screens; this file deliberately doesn't grow that scope.
/** @typedef {import("../protocol.ts").ServerMessage} ServerMessage */
/** @typedef {import("../protocol.ts").PlayerPresence} PlayerPresence */
/** @typedef {import("../protocol.ts").LobbyState} LobbyState */

const TOKEN_KEY = "infrastructure-siege:token";

const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const joinScreen = /** @type {HTMLElement} */ (document.getElementById("join-screen"));
const hudScreen = /** @type {HTMLElement} */ (document.getElementById("hud-screen"));
const joinForm = /** @type {HTMLFormElement} */ (document.getElementById("join-form"));
const nameInput = /** @type {HTMLInputElement} */ (document.getElementById("name"));
const bumpButton = /** @type {HTMLButtonElement} */ (document.getElementById("bump-button"));
const countEl = /** @type {HTMLElement} */ (document.getElementById("count"));
const lastBumpedByEl = /** @type {HTMLElement} */ (document.getElementById("last-bumped-by"));
const playerCountEl = /** @type {HTMLElement} */ (document.getElementById("player-count"));
const playerListEl = /** @type {HTMLElement} */ (document.getElementById("player-list"));
const lobbyNameEl = document.getElementById("lobby-name");

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

/** @type {string | null} */
let myPlayerId = null;
/** @type {string | null} */
let pendingName = null;
/** @type {WebSocket | null} */
let socket = null;
let reconnectAttempt = 0;
let hasJoined = false;

function setStatus(/** @type {"connecting" | "connected" | "disconnected"} */ state) {
  statusEl.dataset.state = state;
  statusEl.textContent =
    state === "connecting" ? "Connecting…" : state === "connected" ? "Connected" : "Disconnected — retrying…";
}

function renderLobby(/** @type {LobbyState} */ lobby) {
  if (lobbyNameEl) lobbyNameEl.textContent = lobby.name;
  countEl.textContent = String(lobby.count);
  lastBumpedByEl.textContent = lobby.lastBumpedBy ?? "nobody yet";

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

function handleMessage(/** @type {ServerMessage} */ msg) {
  if (msg.type === "welcome") {
    myPlayerId = msg.playerId;
    saveToken(msg.token);
    renderLobby(msg.lobby);
    joinScreen.hidden = true;
    hudScreen.hidden = false;
    bumpButton.disabled = false;
    hasJoined = true;
  } else if (msg.type === "lobbyState") {
    renderLobby(msg.lobby);
  } else if (msg.type === "error") {
    console.error("server error:", msg.message);
  }
}

function connect() {
  setStatus(hasJoined ? "disconnected" : "connecting");
  const url = `${location.origin.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(url);
  socket = ws;

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    setStatus("connected");
    // The server resumes identity from the stored token (if any) and
    // rejects any action before 'hello' (1008), so a reconnect has to
    // re-announce itself exactly like a first connection would.
    if (pendingName) {
      bumpButton.disabled = true;
      ws.send(JSON.stringify({ type: "hello", name: pendingName, token: loadToken() ?? undefined }));
    }
  });

  ws.addEventListener("message", (event) => {
    handleMessage(JSON.parse(event.data));
  });

  ws.addEventListener("close", () => {
    bumpButton.disabled = true;
    if (!pendingName) return; // closed before ever joining (e.g. bad name) — don't auto-retry
    setStatus("disconnected");
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10_000);
    reconnectAttempt += 1;
    setTimeout(connect, delay);
  });
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  pendingName = name;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "hello", name, token: loadToken() ?? undefined }));
  }
});

bumpButton.addEventListener("click", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "bump" }));
  }
});

connect();
