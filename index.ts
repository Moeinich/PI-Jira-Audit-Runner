/**
 * Jira Audit Runner Extension
 *
 * Polls Jira for tickets with the "Run audit" trigger and spawns a read-only
 * audit agent for each one.  Posts the audit result as a Jira comment.
 *
 * Activation (opt-in per session):
 *   /jira-audit-runner on [project=KAN] [interval=300] [auditField=10318]
 *   /jira-audit-runner off
 *   /jira-audit-runner status
 *
 * Dedup: each ticket is audited at most once per launch.  The processed label
 * is removed atomically before the subprocess spawns, so a restart/poll-miss
 * between those steps cannot cause a double audit.
 *
 * Tools available to the audit agent: read, grep, find, ls, bash  (bash is
 * required by audit.md d.6 to run `npx jscpd` over feature directories).
 *
 * Lifecycle: the audit subprocess is spawned with `detached: true` so it owns
 * its own process group.  On shutdown — SIGINT/SIGTERM/beforeExit/exit, and
 * session_shutdown — the whole group is signalled (SIGTERM with SIGKILL
 * escalation) to kill both `pi -p` and any tool subprocesses (bash, npx,
 * jscpd) it spawned.  Without this they survive and get reparented to
 * launchd, which is the "leaves agents running" leak.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CODEBASE_ROOT, JIRA_EMAIL, JIRA_API_TOKEN } from "./config";
import { getCurrentProc, killProcessTree } from "./process-tree";
import { createRunner, parseRunnerArgs } from "./runner";
import { loadState, saveState } from "./state";

interface RunnerUIContext {
  hasUI: boolean;
  ui: {
    setStatus: (key: string, text: string) => void;
    notify: (msg: string, type?: string) => void;
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer("jira-audit", (entry, _o, theme) =>
    new Text(theme.fg("dim", `[jira-audit] ${(entry.data as { msg: string }).msg}`), 0, 0),
  );

  const state = loadState();
  let uiCtx: RunnerUIContext | null = null;

  // Safe wrappers — fall back to console if the UI ctx isn't ready or stale.
  function uiSetStatus(key: string, text: string): void {
    try {
      if (uiCtx?.hasUI) uiCtx.ui.setStatus(key, text);
      else if (text) console.log(`[jira-audit] ${text}`);
    } catch {
      /* ctx stale after session restart */
    }
  }
  function uiLog(msg: string): void {
    try {
      if (uiCtx?.hasUI) pi.appendEntry("jira-audit", { msg });
      else console.log(`[jira-audit] ${msg}`);
    } catch {
      /* ctx stale after session restart */
    }
  }
  function uiNotify(msg: string, type = "info"): void {
    try {
      if (uiCtx?.hasUI) uiCtx.ui.notify(msg, type);
      else console.log(`[jira-audit] [${type}] ${msg}`);
    } catch {
      /* ctx stale after session restart */
    }
  }
  function safeEmit(event: string, data: unknown): void {
    try {
      pi.events.emit(event, data as never);
    } catch {
      /* ctx stale after session restart */
    }
  }

  const runner = createRunner(
    state,
    { setStatus: uiSetStatus, log: uiLog, notify: uiNotify, safeEmit },
    CODEBASE_ROOT,
  );

  /**
   * Last-resort kill for the current audit subprocess. Blocks the main
   * thread for up to 2s waiting for graceful exit, then escalates to
   * SIGKILL. Called from session_shutdown AND from process-level signal
   * handlers so a SIGINT (Cmd+C) that bypasses pi's own shutdown still
   * kills the subprocess group.
   */
  function shutdownCleanup(): void {
    const proc = getCurrentProc();
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    killProcessTree(proc, "SIGTERM");
    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      killProcessTree(proc, "SIGKILL");
    }
  }

  process.on("SIGINT", shutdownCleanup);
  process.on("SIGTERM", shutdownCleanup);
  process.on("beforeExit", shutdownCleanup);
  process.on("exit", () => {
    // Sync-only final hard-kill in case the async wait above was bypassed.
    const proc = getCurrentProc();
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      killProcessTree(proc, "SIGKILL");
    }
  });

  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx as RunnerUIContext;
    // No auto-start — user must run /jira-audit-runner on explicitly per session.
  });

  pi.registerCommand("jira-audit-runner", {
    description:
      "Start/stop Jira audit polling. Usage: /jira-audit-runner on [project=KAN] [interval=300] [auditField=10318] | off | status",
    handler: async (rawArgs, ctx) => {
      const args = parseRunnerArgs(typeof rawArgs === "string" ? rawArgs.trim() : "");
      const commandCtx = ctx as { ui: { notify: (msg: string, type?: string) => void } };

      if (args.action === "status") {
        const running = state.enabled && runner.isRunning();
        const status = running
          ? `Running (${state.intervalSecs}s interval, project=${state.project}, field=customfield_${state.auditFieldId}, processed=${state.processedKeys.size})`
          : `Stopped${state.enabled ? " (enabled but not polling — check logs)" : " (use /jira-audit-runner on to start)"}`;
        const current = runner.getCurrentTask() ? ` | Currently auditing: ${runner.getCurrentTask()}` : "";
        commandCtx.ui.notify(`Jira Audit Runner: ${status}${current}`, "info");
        return;
      }

      if (args.action === "off") {
        runner.stopPolling();
        state.enabled = false;
        saveState(state);
        commandCtx.ui.notify("Jira Audit Runner: stopped", "info");
        return;
      }

      if (args.action === "on") {
        if (args.project) state.project = args.project;
        if (args.interval) state.intervalSecs = args.interval;
        if (args.auditFieldId) state.auditFieldId = args.auditFieldId;
        const model = (ctx as { model?: { provider: string; id: string } }).model;
        if (model) state.model = `${model.provider}/${model.id}`;
        state.enabled = true;
        saveState(state);

        if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
          commandCtx.ui.notify(
            "Jira Audit Runner: JIRA_EMAIL and JIRA_API_TOKEN are not set — audit polling will not run. Set them in your shell environment and reload.",
            "error",
          );
          return;
        }

        runner.scheduleNext();
        commandCtx.ui.notify(
          `Jira Audit Runner: started (project=${state.project}, interval=${state.intervalSecs}s, field=customfield_${state.auditFieldId})`,
          "info",
        );
        return;
      }
    },
  });

  pi.on("session_shutdown", () => {
    shutdownCleanup();
    runner.stopPolling();
    state.processedKeys.clear();
    saveState(state);
  });
}
