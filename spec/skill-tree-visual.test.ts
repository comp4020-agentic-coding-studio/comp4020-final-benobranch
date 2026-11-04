// Checks server/public/skill-tree-visual.js's pure function output shape for
// locked/purchasable/researching/unlocked states (issues/ANU-016.md's "GUI
// representation" bullet, redesigned by ANU-019's time-gated research), not
// a rendered screenshot, per CLAUDE.md's current no-manual-e2e rule. Same
// pattern as spec/factory-visual.test.ts / spec/unit-visual.test.ts.
import { expect, it } from "vitest";
import { skillTreeVisual } from "../server/public/skill-tree-visual.js";
import { SKILL_NODES } from "../server/public/skill-tree-nodes.js";

it("a node with no prerequisite and nothing in progress is purchasable (not unlocked, not researching)", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], researching: null });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(false);
  expect(node.researching).toBe(false);
  expect(node.purchasable).toBe(true);
});

it("a node whose prerequisite isn't unlocked is locked even with nothing else in progress", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], researching: null });
  const node = nodes.find((n) => n.id === "advanced-drone")!;
  expect(node.unlocked).toBe(false);
  expect(node.researching).toBe(false);
  expect(node.purchasable).toBe(false);
});

it("a node whose prerequisite IS unlocked and nothing else is in progress becomes purchasable", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: ["drone-chassis"], researching: null });
  const node = nodes.find((n) => n.id === "advanced-drone")!;
  expect(node.unlocked).toBe(false);
  expect(node.purchasable).toBe(true);
});

it("the node currently being researched reports researching true, carrying progressFraction, and is not purchasable", () => {
  const { nodes } = skillTreeVisual({
    unlockedNodeIds: [],
    researching: { nodeId: "better-fabs", startedAt: new Date().toISOString(), progressFraction: 0.4 },
  });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(false);
  expect(node.researching).toBe(true);
  expect(node.progressFraction).toBe(0.4);
  expect(node.purchasable).toBe(false);
});

it("a different, otherwise-purchasable node is locked (not purchasable) while another node is being researched — one active slot per player", () => {
  const { nodes } = skillTreeVisual({
    unlockedNodeIds: [],
    researching: { nodeId: "lean-production", startedAt: new Date().toISOString(), progressFraction: 0.1 },
  });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(false);
  expect(node.researching).toBe(false);
  expect(node.purchasable).toBe(false);
});

it("an already-unlocked node reports unlocked true, researching/purchasable both false", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: ["better-fabs"], researching: null });
  const node = nodes.find((n) => n.id === "better-fabs")!;
  expect(node.unlocked).toBe(true);
  expect(node.researching).toBe(false);
  expect(node.purchasable).toBe(false);
});

it("output covers every defined node exactly once, carrying its icon through", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], researching: null });
  expect(nodes).toHaveLength(SKILL_NODES.length);
  expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(SKILL_NODES.map((n) => n.id)));
  for (const def of SKILL_NODES) {
    expect(nodes.find((n) => n.id === def.id)!.icon).toBe(def.icon);
  }
});
