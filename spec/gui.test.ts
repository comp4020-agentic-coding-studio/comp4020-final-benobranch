// Mechanically checkable parts of the GUI shell: the page the browser
// actually loads has the join form and HUD containers app.js expects, and
// /app.js is served as a real module script (a wrong content-type here fails
// with no console error pointing at it — see server/static-files.ts).
// The realtime *behaviour* (broadcast, presence) is already covered by
// spec/realtime.test.ts; this doesn't duplicate it.
import { JSDOM } from "jsdom";
import { expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");

it("serves a join form and HUD containers in the markup", async () => {
  const res = await fetch(new URL("/", baseUrl));
  expect(res.status).toBe(200);
  const dom = new JSDOM(await res.text());
  const { document } = dom.window;

  expect(document.querySelector("#join-form")).not.toBeNull();
  expect(document.querySelector("#join-form input[name='name']")).not.toBeNull();
  expect(document.querySelector("#hud-screen")).not.toBeNull();
  expect(document.querySelector("#player-list")).not.toBeNull();
  expect(document.querySelector("#bump-button")).not.toBeNull();
  expect(document.querySelector("#status")).not.toBeNull();
  expect(document.querySelector("#lobby-name")).not.toBeNull();
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
