import { useEffect, useMemo, useState } from "react";
import { fetchPaneConversation, fetchPaneTranscript } from "./api.ts";
import type { TrackedAgent } from "./agentTrackingModel.ts";
import { readsScreenModel, screenModel, trackingModelText } from "./agentTrackingNames.ts";

/** how many of a screen's last lines hold the footer that names the model (screenModel) */
const FOOTER_LINES = 8;

/** how often agent tracking asks each agent's conversation for its model, while it is shown */
export const AGENT_MODELS_MS = 30_000;

/**
 * The model each shown agent's conversation last recorded, for agent tracking's first line, by
 * TrackedAgent key, named as the chat's model pill names it (trackingModelText). Read one pane at a
 * time, newest prompt only (`prompts: 1`), on arrival and then every AGENT_MODELS_MS while the page
 * is visible; where the conversation names no model (Kimi, Qwen), the last few lines of the agent's
 * screen are read for the footer that does (screenModel). A read that fails keeps the model last
 * read. Local reads of the PC's transcripts and screens: no model is asked anything.
 */
export function useAgentModels(agents: readonly TrackedAgent[]): ReadonlyMap<string, string> {
  const [models, setModels] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = useMemo(() => agents.filter((agent) => agent.app !== null).map((agent) => ({ key: agent.key, machineId: agent.machineId, paneId: agent.paneId, app: agent.app! })), [agents]);
  const roster = JSON.stringify(wanted.map((item) => [item.key, item.app]));
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const readAll = async (): Promise<void> => {
      const found = new Map<string, string>();
      for (const { key, machineId, paneId, app } of wanted) {
        if (controller.signal.aborted) return;
        let id: string | null = null;
        try {
          const answer = await fetchPaneConversation(paneId, machineId, { prompts: 1, signal: controller.signal });
          id = answer.metadata?.model || null;
        } catch {
          if (controller.signal.aborted) return;
        }
        if (id === null && readsScreenModel(app)) {
          try {
            id = screenModel(app, (await fetchPaneTranscript(paneId, FOOTER_LINES, machineId, controller.signal)).text);
          } catch {
            if (controller.signal.aborted) return;
          }
        }
        if (id) found.set(key, trackingModelText(id));
      }
      setModels((was) => {
        const next = new Map(found);
        for (const { key } of wanted) if (!next.has(key) && was.has(key)) next.set(key, was.get(key)!);
        return next;
      });
    };
    const round = (): void => {
      if (document.visibilityState === "visible") void readAll().finally(() => { if (!controller.signal.aborted) timer = window.setTimeout(round, AGENT_MODELS_MS); });
      else timer = window.setTimeout(round, AGENT_MODELS_MS);
    };
    round();
    return () => { controller.abort(); window.clearTimeout(timer); };
    // the roster's keys, not the agents' changing states, start a new round
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roster]);
  return models;
}
