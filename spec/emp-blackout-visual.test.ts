// Checks server/public/emp-blackout-visual.js's empBlackoutVisual() pure
// function: active/inactive detection and the MM:SS countdown label, fed a
// fixed `now` so every case is exactly reproducible (no real clock, no
// jsdom) — same convention as spec/capture-visual.test.ts.
import { expect, it } from "vitest";
import { empBlackoutVisual } from "../server/public/emp-blackout-visual.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

it("no empActiveUntil entry at all (the common case — no blackout here) reads as inactive", () => {
  const visual = empBlackoutVisual({ empActiveUntil: undefined, now: NOW });
  expect(visual).toEqual({ active: false, countdownLabel: null });
});

it("an expiry in the future is active, with a MM:SS countdown to it", () => {
  const empActiveUntil = new Date(NOW + 5 * 60_000 + 30_000).toISOString(); // 5:30 remaining
  const visual = empBlackoutVisual({ empActiveUntil, now: NOW });
  expect(visual).toEqual({ active: true, countdownLabel: "5:30" });
});

it("seconds under 10 are zero-padded (e.g. 5 seconds reads '0:05', not '0:5')", () => {
  const empActiveUntil = new Date(NOW + 5_000).toISOString();
  const visual = empBlackoutVisual({ empActiveUntil, now: NOW });
  expect(visual.countdownLabel).toBe("0:05");
});

it("the full 20-minute blackout duration reads '20:00'", () => {
  const empActiveUntil = new Date(NOW + 20 * 60_000).toISOString();
  const visual = empBlackoutVisual({ empActiveUntil, now: NOW });
  expect(visual).toEqual({ active: true, countdownLabel: "20:00" });
});

it("an expiry exactly at now (or in the past) reads as inactive, not a negative/garbage countdown", () => {
  expect(empBlackoutVisual({ empActiveUntil: new Date(NOW).toISOString(), now: NOW })).toEqual({ active: false, countdownLabel: null });
  expect(empBlackoutVisual({ empActiveUntil: new Date(NOW - 1000).toISOString(), now: NOW })).toEqual({ active: false, countdownLabel: null });
});

it("an unparseable timestamp degrades to inactive rather than throwing or returning NaN", () => {
  const visual = empBlackoutVisual({ empActiveUntil: "not-a-timestamp", now: NOW });
  expect(visual).toEqual({ active: false, countdownLabel: null });
});
