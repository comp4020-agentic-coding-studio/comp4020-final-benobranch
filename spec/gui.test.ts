// Mechanically checkable parts of the GUI shell: the page the browser
// actually loads has the Home/Browse/Lobby/Options screens and controls
// app.js expects, and /app.js is served as a real module script (a wrong
// content-type here fails with no console error pointing at it — see
// server/static-files.ts). The realtime *behaviour* (broadcast, lobby
// isolation) is already covered by spec/realtime.test.ts; this doesn't
// duplicate it.
import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

it("serves the Home screen's Continue/Server browse/Options controls", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#home-screen")).not.toBeNull();
  expect(document.querySelector("#continue-button")).not.toBeNull();
  expect(document.querySelector("#browse-button")).not.toBeNull();
  expect(document.querySelector("#options-button")).not.toBeNull();
  // Names are per-lobby, set the first time a player joins a lobby — Home
  // itself collects no name (see docs/adr/0002-identity-and-lobbies.md).
  expect(document.querySelector("#home-screen input")).toBeNull();
  // Exit was deliberately dropped (issues/ANU-008.md's Why section) — there
  // should be no button claiming to do it.
  expect(document.body.textContent).not.toMatch(/\bExit\b/);
});

it("serves the Browse screen's lobby list and create-lobby form, with a callsign field", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#browse-screen")).not.toBeNull();
  expect(document.querySelector("#lobby-list")).not.toBeNull();
  expect(document.querySelector("#create-lobby-form")).not.toBeNull();
  // Creating a lobby is also this player's first join to it, so it collects
  // their callsign for that lobby up front.
  expect(document.querySelector("#create-callsign")).not.toBeNull();
  const capacityInput = document.querySelector("#lobby-capacity");
  expect(capacityInput).not.toBeNull();
  // PLAN.md's settled rule (ANU-006): games are 4-12 players.
  expect(capacityInput?.getAttribute("min")).toBe("4");
  expect(capacityInput?.getAttribute("max")).toBe("12");
});

it("serves a name-prompt screen for a player's first join to an existing lobby", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#name-prompt-screen")).not.toBeNull();
  expect(document.querySelector("#name-prompt-form")).not.toBeNull();
  expect(document.querySelector("#join-callsign")).not.toBeNull();
});

it("serves the Lobby screen's status/start/HUD controls", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#lobby-screen")).not.toBeNull();
  expect(document.querySelector("#lobby-status")).not.toBeNull();
  expect(document.querySelector("#start-button")).not.toBeNull();
  expect(document.querySelector("#player-list")).not.toBeNull();
  expect(document.querySelector("#status")).not.toBeNull();
});

// ANU-020: the sidebar overlay replacing the old standalone "Players"
// section — always in the DOM (unlike #map-panel, never [hidden] itself),
// with only its tabs/economy readout hidden pre-start, and #player-list now
// living inside the Territory panel rather than as its own top-level section.
it("serves the sidebar, always unhidden, with tabs/economy hidden by default", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  const sidebar = document.querySelector("#sidebar");
  expect(sidebar).not.toBeNull();
  expect(sidebar?.hasAttribute("hidden")).toBe(false);

  const tabs = document.querySelector("#sidebar-tabs");
  expect(tabs).not.toBeNull();
  expect(tabs?.hasAttribute("hidden")).toBe(true);

  const economy = document.querySelector("#sidebar-economy");
  expect(economy).not.toBeNull();
  expect(economy?.hasAttribute("hidden")).toBe(true);
});

it("serves the Territory/Units/Factories sidebar panels, Territory visible by default", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  const territory = document.querySelector("#panel-territory");
  expect(territory).not.toBeNull();
  expect(territory?.hasAttribute("hidden")).toBe(false);

  const units = document.querySelector("#panel-units");
  expect(units).not.toBeNull();
  expect(units?.hasAttribute("hidden")).toBe(true);

  const factories = document.querySelector("#panel-factories");
  expect(factories).not.toBeNull();
  expect(factories?.hasAttribute("hidden")).toBe(true);

  // #player-list moved inside the Territory panel (ANU-020), not a
  // standalone top-level section below the map any more.
  expect(document.querySelector("#panel-territory #player-list")).not.toBeNull();

  expect(document.querySelector("#suburb-detail")).not.toBeNull();
  expect(document.querySelector("#unit-list")).not.toBeNull();
  expect(document.querySelector("#factory-list")).not.toBeNull();
});

// ANU-011: a started lobby shows the real map (ANU-010) instead of ANU-005's
// placeholder counter/bump panel; a waiting lobby shows neither yet. The
// map panel's markup is always present in the static page (so app.js has
// something to mount into) but starts hidden — app.js unhides it only once
// `lobbyState.started` is true (see server/public/app.js's renderLobbyScreen).
it("serves the Lobby screen's map panel hidden by default, and no counter/bump controls", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  const mapPanel = document.querySelector("#map-panel");
  expect(mapPanel).not.toBeNull();
  expect(mapPanel?.hasAttribute("hidden")).toBe(true);
  expect(document.querySelector("#bump-button")).toBeNull();
  expect(document.querySelector("#count")).toBeNull();
  expect(document.querySelector("#last-bumped-by")).toBeNull();
});

// The lobby screen's own header (with its "← Browse" link) is hidden once a
// started game goes fullscreen (style.css's `.lobby-screen--fullscreen >
// .hud-bar` rule) — the map panel's header is the one place that stays
// visible throughout, so it's where a way back to the menu has to live.
it("serves a back-to-menu link inside the map panel's header, which stays visible once a game is fullscreen", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  const backLink = document.querySelector("#map-panel .hud-bar a.back-link");
  expect(backLink).not.toBeNull();
  expect(backLink?.getAttribute("href")).toBe("#/home");
});

it("serves the map's unit/factory/ownership SVG layers for ANU-020's renderUnits/renderFactories/renderOwnership to mount into", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#map-ownership")).not.toBeNull();
  expect(document.querySelector("#map-factories")).not.toBeNull();
  expect(document.querySelector("#map-units")).not.toBeNull();
});

it("serves the map's base SVG layer for ANU-025's renderBases to mount into", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#map-bases")).not.toBeNull();
});

it("serves a reachable Options placeholder screen", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#options-screen")).not.toBeNull();
});

it("serves /app.js as an executable module script", async () => {
  const res = await fetch(new URL("/app.js", baseUrl));
  expect(res.status).toBe(200);
  // Browsers refuse <script type="module"> unless this is a JS MIME type.
  expect(res.headers.get("content-type")).toMatch(/javascript/);
  const body = await res.text();
  expect(body.length).toBeGreaterThan(0);
});

it("serves /style.css referenced by the page", async () => {
  const pageRes = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await pageRes.text());
  const href = dom.window.document.querySelector("link[rel='stylesheet']")?.getAttribute("href");
  expect(href).toBeTruthy();

  const cssRes = await fetch(new URL(href!, baseUrl));
  expect(cssRes.status).toBe(200);
  expect(cssRes.headers.get("content-type")).toMatch(/css/);
});

it("refuses to serve a file outside the public directory", async () => {
  const res = await fetch(new URL("/%2e%2e/package.json", baseUrl));
  expect(res.status).toBe(404);
});
