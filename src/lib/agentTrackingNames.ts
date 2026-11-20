import { modelLabel } from "./modelName.ts";

/** A part that is only a folder: `~`, `~/x`, `/x`. */
const FOLDER = /^~(?:\/\S*)?$|^\/\S*$/;
/** A shell's own window title: `user@host`, `user@host: ~/x`. */
const SHELL_TITLE = /^[\w.-]+@[\w.-]+(?::.*)?$/;
/** Where a title joins its parts: "Fix login | ovis", "Qwen - ovis". */
const JOIN = /(\s+[|·•—–-]\s+)/;

/**
 * Agent tracking's task text for a row: the sidebar's words for it, less what is not a task.
 * hc's `<hc from=…>` wrapper goes; a shell's `user@host: ~/x` title, a folder, the workspace's
 * name (the second line's) and the agent's own name (the first line's) go as whole parts. What
 * is left may be "" when the title said nothing else.
 */
export function trackingTask(label: string, workspace: string, agentNames: readonly string[]): string {
  const text = label.replace(/<\/?hc\b[^>]*>/gi, " ").replace(/\s+/g, " ").trim();
  // as the sidebar compares names (titleOnlyNamesAgent): leading marks ("✳ Claude") and case aside
  const plain = (part: string): string => part.replace(/^[^\p{L}\p{N}~/]+/u, "").trim().toLowerCase();
  const drop = new Set([workspace, ...agentNames, ...agentNames.map((name) => name.trim().split(/\s+/)[0] ?? "")].map(plain).filter(Boolean));
  const pieces = text.split(JOIN);
  const kept: string[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const part = pieces[index]!.trim();
    if (plain(part) === "" || SHELL_TITLE.test(part) || FOLDER.test(part) || drop.has(plain(part))) continue;
    if (kept.length > 0) kept.push(pieces[index - 1]!);
    kept.push(part);
  }
  return kept.join("");
}

/**
 * Footers that name the running model, for agents whose conversation Ovis cannot read it from:
 * Kimi Code's `kimi-k3 thinking: high  ~/x`, Qwen Code's `➜ x · qwen3.8-max xhigh · …`.
 */
const SCREEN_MODELS: readonly { app: RegExp; model: RegExp }[] = [
  { app: /^kimi/, model: /(?:^|\s)(kimi-[\w.]+(?:-[\w.]+)*)\s+thinking:/m },
  { app: /^qwen/, model: /·\s+(qwen[\w.]*(?:-[\w.]+)*)\s/ },
];

/** The model an agent's own screen names in its footer (the last lines of its screen), else null. */
export function screenModel(app: string, screen: string): string | null {
  for (const entry of SCREEN_MODELS) {
    if (!entry.app.test(app)) continue;
    const lines = screen.split("\n");
    for (let index = lines.length - 1; index >= 0; index--) {
      const found = entry.model.exec(lines[index]!);
      if (found) return found[1]!;
    }
  }
  return null;
}

/** Whether screenModel knows this agent's footer, so a screen read is worth asking for. */
export function readsScreenModel(app: string): boolean {
  return SCREEN_MODELS.some((entry) => entry.app.test(app));
}

/**
 * A model id as the first line shows it: the chat pill's name where Ovis knows one ("Opus 5.5"),
 * else the id with each part capitalised ("kimi-k3" → "Kimi-K3").
 */
export function trackingModelText(id: string): string {
  const known = modelLabel(id).text;
  if (known !== id) return known;
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return bare.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
}
