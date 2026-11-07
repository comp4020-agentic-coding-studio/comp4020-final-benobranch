// Checks server/public/marker-offset.js's quadrantAnchor() pure function
// against issues/ANU-050.md's "Done when" bullet: a suburb with a data
// center, a player base, a factory, and a unit stack all at once must leave
// every one of the four at least partially visible/tappable. map.js anchors
// the data-center/base/factory markers into three different quadrants
// around a shared label_point (quadrantAnchor's own file comment: data
// centers upper-left, bases upper-right, factories lower-left) instead of
// centering all of them on the same point — these tests check the geometry
// that claim rests on, not a rendered screenshot, per CLAUDE.md's
// no-manual-e2e rule. Same "no DOM, pure data in/shape out" pattern as
// spec/unit-marker-layout.test.ts/spec/factory-visual.test.ts.
import { expect, it } from "vitest";
import { quadrantAnchor } from "../server/public/marker-offset.js";

/** @returns {[number, number, number, number]} [minX, minY, maxX, maxY] */
function bounds(
  center: [number, number],
  size: number,
): [number, number, number, number] {
  const [cx, cy] = center;
  return [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2];
}

/** Whether two axis-aligned boxes share more than a zero-area edge/corner. */
function overlapsWithPositiveArea(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  const [aMinX, aMinY, aMaxX, aMaxY] = a;
  const [bMinX, bMinY, bMaxX, bMaxY] = b;
  const overlapWidth = Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX);
  const overlapHeight = Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY);
  return overlapWidth > 0 && overlapHeight > 0;
}

it("anchors a marker so the LABEL POINT itself sits at the corner of the marker nearest (dirX, dirY) — not the marker's center", () => {
  // dirX=-1,dirY=-1 (upper-left, map.js's data-center anchor): the marker's
  // own bottom-right corner should land exactly on labelPoint.
  const labelPoint: [number, number] = [1000, 2000];
  const size = 400;
  const [cx, cy] = quadrantAnchor(labelPoint, size, -1, -1);
  const [, , maxX, maxY] = bounds([cx, cy], size);
  expect(maxX).toBeCloseTo(labelPoint[0]);
  expect(maxY).toBeCloseTo(labelPoint[1]);
});

it("the four quadrant directions each offset the marker's center by exactly half its size, in the expected direction", () => {
  const labelPoint: [number, number] = [0, 0];
  const size = 100;
  expect(quadrantAnchor(labelPoint, size, -1, -1)).toEqual([-50, -50]);
  expect(quadrantAnchor(labelPoint, size, 1, -1)).toEqual([50, -50]);
  expect(quadrantAnchor(labelPoint, size, -1, 1)).toEqual([-50, 50]);
  expect(quadrantAnchor(labelPoint, size, 1, 1)).toEqual([50, 50]);
});

it("centering a marker at a (dirX, dirY) of (0 scaled away) is equivalent to the old behaviour when size is 0 — degenerate but consistent", () => {
  const labelPoint: [number, number] = [42, 99];
  expect(quadrantAnchor(labelPoint, 0, -1, -1)).toEqual(labelPoint);
});

it("two markers anchored into opposite horizontal quadrants (data-center upper-left vs base upper-right) never overlap, regardless of either marker's size", () => {
  const labelPoint: [number, number] = [500, 500];
  // Exercise map.js's real marker sizes (320-900 map units) plus some
  // extremes, since issues/ANU-050.md's bug report specifically called out
  // that size range as where overlap used to be routine.
  for (const dcSize of [320, 440, 640, 900, 2000]) {
    for (const baseSize of [320, 900, 2000]) {
      const dcCenter = quadrantAnchor(labelPoint, dcSize, -1, -1);
      const baseCenter = quadrantAnchor(labelPoint, baseSize, 1, -1);
      expect(
        overlapsWithPositiveArea(bounds(dcCenter, dcSize), bounds(baseCenter, baseSize)),
        `data-center (size ${dcSize}) and base (size ${baseSize}) markers must not overlap`,
      ).toBe(false);
    }
  }
});

it("all three quadrant-anchored marker types map.js actually uses (data center upper-left, base upper-right, factory lower-left) are pairwise non-overlapping at their real marker sizes", () => {
  const labelPoint: [number, number] = [12345, 6789];
  const DATA_CENTER_SIZES = [440, 640, 900]; // standard/major/mega tiers
  const BASE_SIZE = 320;
  const FACTORY_SIZE = 280;

  for (const dcSize of DATA_CENTER_SIZES) {
    const dc = bounds(quadrantAnchor(labelPoint, dcSize, -1, -1), dcSize);
    const base = bounds(quadrantAnchor(labelPoint, BASE_SIZE, 1, -1), BASE_SIZE);
    const factory = bounds(quadrantAnchor(labelPoint, FACTORY_SIZE, -1, 1), FACTORY_SIZE);

    expect(overlapsWithPositiveArea(dc, base), `dc(${dcSize}) vs base`).toBe(false);
    expect(overlapsWithPositiveArea(dc, factory), `dc(${dcSize}) vs factory`).toBe(false);
    expect(overlapsWithPositiveArea(base, factory), "base vs factory").toBe(false);
  }
});

it("a marker still CENTERED on label_point (the unit-stack marker, which keeps its own fan-out instead of a quadrant anchor) only clips the one nearest corner of a quadrant-anchored marker, never its full footprint", () => {
  const labelPoint: [number, number] = [0, 0];
  const quadrantSize = 900; // mega data center, the largest marker on the map
  const unitSize = 320; // UNIT_MARKER_SIZE
  const dcBounds = bounds(quadrantAnchor(labelPoint, quadrantSize, -1, -1), quadrantSize);
  const unitBounds = bounds(labelPoint, unitSize); // centered, unmoved

  // They DO overlap (that's expected and fine — only the nearest corner)...
  expect(overlapsWithPositiveArea(dcBounds, unitBounds)).toBe(true);
  // ...but the data-center marker's far corner (farthest from label_point)
  // stays completely outside the unit marker's footprint, i.e. it isn't
  // fully covered.
  const [dcMinX, dcMinY] = dcBounds;
  const [, , unitMaxX, unitMaxY] = unitBounds;
  expect(dcMinX < unitBounds[0] || dcMinY < unitBounds[1]).toBe(true);
  expect(dcMinX).toBeLessThan(0);
  expect(dcMinY).toBeLessThan(0);
  // The far corner (dcMinX, dcMinY) sits outside the unit marker's box.
  const farCornerInsideUnit =
    dcMinX >= unitBounds[0] && dcMinX <= unitMaxX && dcMinY >= unitBounds[1] && dcMinY <= unitMaxY;
  expect(farCornerInsideUnit).toBe(false);
});
