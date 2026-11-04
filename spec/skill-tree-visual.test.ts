// Checks server/public/skill-tree-visual.js's pure function output shape for
// locked/purchasable/researching/unlocked states (issues/ANU-016.md's "GUI
// representation" bullet, redesigned by ANU-019's time-gated research), not
// a rendered screenshot, per CLAUDE.md's current no-manual-e2e rule. Same
// pattern as spec/factory-visual.test.ts / spec/unit-visual.test.ts.
import { existsSync } from "node:fs";
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

// ANU-029: the Research tab's display fields.
it("lockedReason is 'prerequisite' when the prerequisite is missing, even while another node is researching", () => {
  const researching = { nodeId: "better-fabs", startedAt: new Date().toISOString(), progressFraction: 0.2 };
  for (const state of [{ unlockedNodeIds: [], researching: null }, { unlockedNodeIds: [], researching }]) {
    const node = skillTreeVisual(state).nodes.find((n) => n.id === "advanced-robot")!;
    expect(node.lockedReason).toBe("prerequisite");
  }
});

it("lockedReason is 'busy' for a prereq-met node while another node holds the research slot", () => {
  const researching = { nodeId: "better-fabs", startedAt: new Date().toISOString(), progressFraction: 0.2 };
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], researching });
  expect(nodes.find((n) => n.id === "salvage-training")!.lockedReason).toBe("busy");
});

it("lockedReason is null for unlocked, researching and purchasable nodes", () => {
  const researching = { nodeId: "advanced-drone", startedAt: new Date().toISOString(), progressFraction: 0.5 };
  const withSlotBusy = skillTreeVisual({ unlockedNodeIds: ["drone-chassis"], researching }).nodes;
  expect(withSlotBusy.find((n) => n.id === "drone-chassis")!.lockedReason).toBeNull(); // unlocked
  expect(withSlotBusy.find((n) => n.id === "advanced-drone")!.lockedReason).toBeNull(); // researching
  const idle = skillTreeVisual({ unlockedNodeIds: [], researching: null }).nodes;
  expect(idle.find((n) => n.id === "better-fabs")!.lockedReason).toBeNull(); // purchasable
});

it("carries each node's display name, description, effectLive and prerequisiteId through", () => {
  const { nodes } = skillTreeVisual({ unlockedNodeIds: [], researching: null });
  for (const def of SKILL_NODES) {
    const node = nodes.find((n) => n.id === def.id)!;
    expect(node.name).toBe(def.name);
    expect(node.name.length).toBeGreaterThan(0);
    expect(node.description.length).toBeGreaterThan(0);
    expect(node.effectLive).toBe(def.effectLive);
    expect(node.prerequisiteId).toBe(def.prerequisiteId);
  }
});

it("data-uplink is flagged as having no effect yet (its multiplier has no reader)", () => {
  expect(SKILL_NODES.find((n) => n.id === "data-uplink")!.effectLive).toBe(false);
});

it("every node's icon (and the researching icon) is a real file under server/public/", () => {
  const publicDir = new URL("../server/public/", import.meta.url);
  for (const path of [...SKILL_NODES.map((n) => n.icon), "icons/skills/researching.png"]) {
    expect(existsSync(new URL(path, publicDir)), path).toBe(true);
  }
});
