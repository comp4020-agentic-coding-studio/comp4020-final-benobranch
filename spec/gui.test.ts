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
  expect(document.querySelector("#callsign")).not.toBeNull();
  expect(document.querySelector("#continue-button")).not.toBeNull();
  expect(document.querySelector("#browse-button")).not.toBeNull();
  expect(document.querySelector("#options-button")).not.toBeNull();
  // Exit was deliberately dropped (issues/ANU-008.md's Why section) — there
  // should be no button claiming to do it.
  expect(document.body.textContent).not.toMatch(/\bExit\b/);
});

it("serves the Browse screen's lobby list and create-lobby form", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#browse-screen")).not.toBeNull();
  expect(document.querySelector("#lobby-list")).not.toBeNull();
  expect(document.querySelector("#create-lobby-form")).not.toBeNull();
  const capacityInput = document.querySelector("#lobby-capacity");
  expect(capacityInput).not.toBeNull();
  // PLAN.md's settled rule (ANU-006): games are 4-12 players.
  expect(capacityInput?.getAttribute("min")).toBe("4");
  expect(capacityInput?.getAttribute("max")).toBe("12");
});

it("serves the Lobby screen's status/start/HUD controls", async () => {
  const res = await fetch(new URL("/", baseUrl));
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#lobby-screen")).not.toBeNull();
  expect(document.querySelector("#lobby-status")).not.toBeNull();
  expect(document.querySelector("#start-button")).not.toBeNull();
  expect(document.querySelector("#player-list")).not.toBeNull();
  expect(document.querySelector("#bump-button")).not.toBeNull();
  expect(document.querySelector("#status")).not.toBeNull();
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
