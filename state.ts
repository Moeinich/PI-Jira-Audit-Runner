import * as fs from "node:fs";
import * as path from "node:path";
import { STATE_FILE } from "./config";

export interface RunnerState {
  enabled: boolean;
  project: string;
  intervalSecs: number;
  auditFieldId: number;
  model?: string;
  processedKeys: Set<string>;
}

export function loadState(): RunnerState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      return {
        enabled: raw.enabled ?? false,
        project: raw.project ?? "KAN",
        intervalSecs: raw.intervalSecs ?? 300,
        auditFieldId: raw.auditFieldId ?? 10318,
        model: raw.model,
        processedKeys: new Set<string>(raw.processedKeys ?? []),
      };
    }
  } catch {
    /* corrupt file — start fresh */
  }
  return {
    enabled: false,
    project: "KAN",
    intervalSecs: 300,
    auditFieldId: 10318,
    model: undefined,
    processedKeys: new Set<string>(),
  };
}

export function saveState(state: RunnerState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      enabled: state.enabled,
      project: state.project,
      intervalSecs: state.intervalSecs,
      auditFieldId: state.auditFieldId,
      model: state.model,
      processedKeys: Array.from(state.processedKeys),
    }),
    "utf-8",
  );
}
