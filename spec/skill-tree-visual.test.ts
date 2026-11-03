// Checks server/public/skill-tree-visual.js's pure function output shape for
// locked/purchasable/unlocked states (issues/ANU-016.md's "GUI
// representation" bullet), not a rendered screenshot, per CLAUDE.md's
// current no-manual-e2e rule. Same pattern as spec/factory-visual.test.ts /
// spec/unit-visual.test.ts.
import { expect, it } from "vitest";
import { skillTreeVisual } from "../server/public/skill-tree-visual.js";
import { SKILL_NODES } from "../server/public/skill-tree-nodes.js";

it("a node with no prerequisite and enough TFLOPS is purchasable (not unlocked)", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], tflops: 1000 });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(false);
  expect(node.purchasable).toBe(true);
});

it("a node with no prerequisite but insufficient TFLOPS is neither unlocked nor purchasable (locked)", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], tflops: 0 });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(false);
  expect(node.purchasable).toBe(false);
});

it("a node whose prerequisite isn't unlocked is locked even with enough TFLOPS", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], tflops: 1000 });
  const node = nodes.find((n) => n.id === "advanced-drone")!;
  expect(node.unlocked).toBe(false);
  expect(node.purchasable).toBe(false);
});

it("a node whose prerequisite IS unlocked and is affordable becomes purchasable", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: ["drone-chassis"], tflops: 1000 });
  const node = nodes.find((n) => n.id === "advanced-drone")!;
  expect(node.unlocked).toBe(false);
  expect(node.purchasable).toBe(true);
});

it("an already-unlocked node reports unlocked true and purchasable false, mutually exclusive", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: ["better-fabs"], tflops: 1000 });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(true);
  expect(node.purchasable).toBe(false);
});

it("output covers every defined node exactly once, carrying its icon through", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], tflops: 0 });
  expect(nodes).toHaveLength(SKILL_NODES.length);
  expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(SKILL_NODES.map((n) => n.id)));
  for (const def of SKILL_NODES) {
    expect(nodes.find((n) => n.id === def.id)!.icon).toBe(def.icon);
  }
});
