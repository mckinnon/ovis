import { describe, expect, test } from "bun:test";
import { readsScreenModel, screenModel, trackingModelText, trackingTask } from "./agentTrackingNames.ts";

const WS = "ovis-agent-animation";

describe("trackingTask", () => {
  test("keeps a real task", () => {
    expect(trackingTask("Fix the login", WS, ["codex", "Codex"])).toBe("Fix the login");
  });
  test("drops the workspace a title appends", () => {
    expect(trackingTask("Implement server and tests | ovis-agent-animation", WS, ["codex", "Codex"])).toBe("Implement server and tests");
  });
  test("drops hc's wrapper but keeps its words", () => {
    expect(trackingTask('<hc from="t19">Task from Claude ', WS, ["kimi", "Kimi Code"])).toBe("Task from Claude");
  });
  test("a shell's user@host title says no task", () => {
    expect(trackingTask("godfrey@ai-workstation: ~/ovis-agent-animation", WS, ["kimi"])).toBe("");
    expect(trackingTask("godfrey@ai-workstation", WS, ["kimi"])).toBe("");
  });
  test("folders, the workspace and the agent's own name say no task", () => {
    expect(trackingTask("~/ovis-agent-animation", WS, [])).toBe("");
    expect(trackingTask("ovis-agent-animation", WS, ["qwen"])).toBe("");
    expect(trackingTask("Qwen - ovis-agent-animation        ", WS, ["qwen", "Qwen Code"])).toBe("");
    expect(trackingTask("✳ Claude Code", WS, ["claude", "Claude Code"])).toBe("");
  });
  test("a hyphen inside words is not a join", () => {
    expect(trackingTask("Port the scene-graph code", WS, [])).toBe("Port the scene-graph code");
    expect(trackingTask("Draft A - draft B", WS, [])).toBe("Draft A - draft B");
  });
});

describe("screenModel", () => {
  test("reads Kimi Code's footer", () => {
    const screen = " ╰──╯\n Ask When Needed  kimi-k3 thinking: high  ~/ovis-agent-animation      ctrl+o expand\n     context: 15% (146k/1M)";
    expect(screenModel("kimi", screen)).toBe("kimi-k3");
    expect(screenModel("kimi-code", " kimi-k3.1-pro thinking: low  ~/x")).toBe("kimi-k3.1-pro");
  });
  test("reads Qwen Code's footer", () => {
    expect(screenModel("qwen", "> hi\n  ➜ ovis-agent-animation · qwen3.8-max xhigh · 1.0m Context 1.8% used\n  Auto mode")).toBe("qwen3.8-max");
  });
  test("other agents and other text read nothing", () => {
    expect(screenModel("codex", " kimi-k3 thinking: high")).toBeNull();
    expect(screenModel("kimi", "I used kimi-k3 yesterday")).toBeNull();
    expect(readsScreenModel("kimi")).toBe(true);
    expect(readsScreenModel("claude")).toBe(false);
  });
});

describe("trackingModelText", () => {
  test("uses the chat pill's name where Ovis knows one", () => {
    expect(trackingModelText("claude-opus-5-5")).toBe("Opus 5.5");
  });
  test("capitalises an id Ovis does not name", () => {
    expect(trackingModelText("kimi-k3")).toBe("Kimi-K3");
    expect(trackingModelText("moonshot-ai/kimi-k3")).toBe("Kimi-K3");
    expect(trackingModelText("qwen3.8-max")).toBe("Qwen3.8-Max");
  });
});
