// @ts-check
// Plain ES module — the server has no build step and browsers can't run
// TypeScript, so this stays hand-written JS rather than introducing a
// bundler for a GUI this small. Typed against server/protocol.ts via JSDoc
// so `pnpm typecheck` still catches a drifted message shape.
/** @typedef {import("../protocol.ts").ServerMessage} ServerMessage */
/** @typedef {import("../protocol.ts").PlayerSummary} PlayerSummary */

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

function renderPlayers(/** @type {PlayerSummary[]} */ players) {
  playerCountEl.textContent = `${players.length} online`;
  playerListEl.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement("li");
      if (p.playerId === myPlayerId) li.classList.add("self");
      const dot = document.createElement("span");
      dot.className = "player-list__dot";
      const label = document.createElement("span");
      // textContent, never innerHTML: player names are untrusted input
      // broadcast to every connected client.
      label.textContent = p.playerId === myPlayerId ? `${p.name} (you)` : p.name;
      li.append(dot, label);
      return li;
    }),
  );
}

function handleMessage(/** @type {ServerMessage} */ msg) {
  if (msg.type === "welcome") {
    myPlayerId = msg.playerId;
    countEl.textContent = String(msg.count);
    renderPlayers(msg.players);
    joinScreen.hidden = true;
    hudScreen.hidden = false;
    bumpButton.disabled = false;
    hasJoined = true;
  } else if (msg.type === "counter") {
    countEl.textContent = String(msg.count);
    lastBumpedByEl.textContent = msg.lastBumpedBy ?? "nobody yet";
  } else if (msg.type === "presence") {
    renderPlayers(msg.players);
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
    // The server assigns a fresh playerId per connection and rejects any
    // action before 'hello' (1008), so a reconnect has to re-announce
    // itself exactly like a first connection would.
    if (pendingName) {
      bumpButton.disabled = true;
      ws.send(JSON.stringify({ type: "hello", name: pendingName }));
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
    socket.send(JSON.stringify({ type: "hello", name }));
  }
});

bumpButton.addEventListener("click", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "bump" }));
  }
});

connect();
