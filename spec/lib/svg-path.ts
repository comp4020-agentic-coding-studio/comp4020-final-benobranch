// Minimal SVG path parser for the plain "M x,y L x,y ... Z" paths
// scripts/map/build_geometry.py emits (no curves, no relative commands) —
// just enough to read back the vertex list for a geometric check, not a
// general SVG path interpreter.
export function pathVertices(path: string): [number, number][] {
  const points: [number, number][] = [];
  for (const sub of path.match(/M[^M]*/g) ?? []) {
    const nums = sub.match(/-?\d+\.?\d*/g) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      points.push([Number(nums[i]), Number(nums[i + 1])]);
    }
  }
  return points;
}

export function minVertexDistance(a: [number, number][], b: [number, number][]): number {
  let best = Infinity;
  for (const [ax, ay] of a) {
    for (const [bx, by] of b) {
      const d = Math.hypot(ax - bx, ay - by);
      if (d < best) best = d;
    }
  }
  return best;
}
