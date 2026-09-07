import { JIRA_EMAIL, JIRA_API_TOKEN } from "./config";
import {
  addJiraComment,
  fetchTriggeredTickets,
  jiraRequest,
  markTicketProcessed,
  nextRetryValue,
  readOption,
  type JiraIssue,
} from "./jira-client";
import { runAuditSubprocess } from "./audit-subprocess";
import { saveState, type RunnerState } from "./state";

export interface RunnerUI {
  setStatus(key: string, text: string): void;
  log(msg: string): void;
  notify(msg: string, type?: string): void;
  safeEmit(event: string, data: unknown): void;
}

export interface ParsedRunnerArgs {
  action: "on" | "off" | "status";
  project?: string;
  interval?: number;
  auditFieldId?: number;
}

export function parseRunnerArgs(input: string): ParsedRunnerArgs {
  const parts = (input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((p) =>
    p.replace(/^["']|["']$/g, ""),
  );

  const action = parts[0]?.toLowerCase() ?? "status";

  if (action === "status") return { action: "status" };
  if (action === "off") return { action: "off" };
  if (action !== "on") return { action: "status" };

  const result: ParsedRunnerArgs = { action: "on" };
  for (const part of parts.slice(1)) {
    if (part.startsWith("project=")) result.project = part.slice(8);
    else if (part.startsWith("interval=")) result.interval = parseInt(part.slice(9), 10);
    else if (part.startsWith("auditField=")) result.auditFieldId = parseInt(part.slice(11), 10);
    else if (/^\d+$/.test(part)) result.interval = parseInt(part, 10);
    else result.project = part;
  }
  return result;
}

export interface Runner {
  scheduleNext(): void;
  stopPolling(): void;
  pollOnce(): Promise<void>;
  getCurrentTask(): string | null;
  isRunning(): boolean;
}

export function createRunner(
  state: RunnerState,
  ui: RunnerUI,
  codebaseRoot: string,
): Runner {
  let pollingTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let currentTask: string | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let nextPollDeadline: number | null = null;

  /** Refresh the idle footer once with remaining seconds. Skipped if currently auditing. */
  function refreshCountdown() {
    if (currentTask) return;
    if (nextPollDeadline === null) return;
    const remaining = Math.max(0, Math.ceil((nextPollDeadline - Date.now()) / 1000));
    ui.setStatus("jira-audit", `Jira Audit: idle (next in ${remaining}s)`);
  }

  /** Capture the next-poll deadline and start ticking the footer every 5s. */
  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    nextPollDeadline = Date.now() + state.intervalSecs * 1000;
    refreshCountdown();
    countdownTimer = setInterval(() => refreshCountdown(), 5_000);
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    nextPollDeadline = null;
  }

  function stopPolling() {
    if (pollingTimer) {
      clearTimeout(pollingTimer);
      pollingTimer = null;
    }
    abortController?.abort();
    abortController = null;
    currentTask = null;
    stopCountdown();
    ui.setStatus("jira-audit", "");
  }

  function scheduleNext() {
    stopPolling();
    abortController = new AbortController();
    const runPoll = async () => {
      if (!state.enabled) return;
      await pollOnce();
      if (!state.enabled) return;
      pollingTimer = setTimeout(runPoll, state.intervalSecs * 1000);
      startCountdown();
    };
    runPoll();
  }

  async function pollOnce() {
    if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
      const msg = "JIRA_EMAIL / JIRA_API_TOKEN not set";
      ui.notify(`Jira Audit Runner: ${msg}`, "error");
      ui.safeEmit("jira-audit:error", { msg });
      return;
    }

    let tickets: JiraIssue[];
    try {
      const fetched = await fetchTriggeredTickets(
        state.project,
        state.auditFieldId,
        abortController!.signal,
      );
      tickets = fetched.filter((i) => !state.processedKeys.has(i.key));
    } catch (err) {
      const msg = `Jira fetch failed: ${err instanceof Error ? err.message : err}`;
      ui.notify(msg, "error");
      ui.safeEmit("jira-audit:error", { msg });
      return;
    }

    ui.setStatus(
      "jira-audit",
      tickets.length === 0
        ? `Jira Audit: idle (next in ${state.intervalSecs}s)`
        : `Jira Audit: auditing ${tickets[0].key}…`,
    );
    ui.log(
      tickets.length === 0
        ? `Jira Audit Runner: polled — no tickets with audit checkbox set in ${state.project} (next in ${state.intervalSecs}s)`
        : `Jira Audit Runner: found ${tickets[0].key} — starting audit…`,
    );

    if (tickets.length === 0) return;

    const ticket = tickets[0];
    if (!ticket.fields) {
      ui.log(`Poll: skipped ${ticket.key} — no fields returned`);
      return;
    }
    currentTask = ticket.key;

    ui.safeEmit("jira-audit:started", {
      key: ticket.key,
      summary: ticket.fields.summary,
    });

    const currentOpt = readOption(ticket, state.auditFieldId);

    // Mark in-flight in state. Failure leaves the field on the next retry
    // value; success clears it. In-session dedup via processedKeys.
    state.processedKeys.add(ticket.key);
    saveState(state);

    try {
      let description: unknown = null;
      let comments: import("./jira-client").JiraComment[] = [];
      try {
        const full = await jiraRequest<JiraIssue>(
          "GET",
          `/rest/api/3/issue/${ticket.key}?fields=description,comment`,
          undefined,
          abortController!.signal,
        );
        description = full.fields.description;
        comments = full.fields.comment?.comments ?? [];
      } catch {
        /* non-fatal */
      }

      const result = await runAuditSubprocess(
        ticket.key,
        ticket.fields.summary ?? "",
        description,
        comments,
        state.model,
        abortController!.signal,
        (status) => {
          ui.safeEmit("jira-audit:status", { key: ticket.key, status });
          ui.setStatus(
            "jira-audit",
            `Jira Audit: auditing ${ticket.key}… ${status.slice(-60)}`,
          );
        },
        ui.log,
        codebaseRoot,
      );

      ui.log(
        `[jira-audit] ${ticket.key}: subprocess returned, exitCode=${result.exitCode}, outputLen=${result.output?.length ?? 0}, errorLen=${result.error?.length ?? 0}`,
      );
      const attemptLabel =
        currentOpt === "true" ? " (initial)"
        : currentOpt === "1" ? " (retry 1)"
        : currentOpt === "2" ? " (retry 2)"
        : currentOpt === "3" ? " (retry 3)"
        : "";

      let commentBody: string;
      if (result.exitCode === 0 && result.output) {
        commentBody = `## 🤖 Code Audit\n\n**Audit agent:** audit\n**Result:** ✅ Completed${attemptLabel}\n\n${result.output}`;
      } else if (result.error) {
        commentBody = `## 🤖 Code Audit\n\n**Audit agent:** audit\n**Result:** ⚠️ Finished with errors${attemptLabel}\n\n\`\`\`\n${result.error}\n\`\`\`\n\n${result.output || "(no output)"}`;
      } else {
        commentBody = `## 🤖 Code Audit\n\n**Audit agent:** audit\n**Result:** ⚠️ No output${attemptLabel}\n\n${result.output || "(empty)"}`;
      }
      try {
        await addJiraComment(ticket.key, commentBody, abortController!.signal);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ui.log(`[jira-audit] ${ticket.key}: comment FAILED: ${errMsg}`);
        ui.notify(
          `Jira Audit Runner: could not post comment on ${ticket.key}: ${errMsg}`,
          "error",
        );
        ui.safeEmit("jira-audit:error", {
          msg: `Failed to post comment on ${ticket.key}: ${errMsg}`,
        });
      }

      const succeeded = result.exitCode === 0 && result.output.length > 0;
      try {
        await markTicketProcessed(
          ticket.key,
          state.auditFieldId,
          succeeded ? null : nextRetryValue(currentOpt),
          abortController!.signal,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ui.log(`[jira-audit] ${ticket.key}: field update FAILED: ${errMsg}`);
        ui.notify(
          `Jira Audit Runner: could not update audit field on ${ticket.key}`,
          "error",
        );
        ui.safeEmit("jira-audit:error", {
          msg: `Failed to update audit field on ${ticket.key}: ${err instanceof Error ? err.message : err}`,
        });
      }
    } catch (err) {
      ui.safeEmit("jira-audit:error", {
        msg: `Audit failed for ${ticket.key}: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      state.processedKeys.delete(ticket.key);
      saveState(state);
      currentTask = null;
      ui.setStatus("jira-audit", `Jira Audit: idle (next in ${state.intervalSecs}s)`);
      ui.safeEmit("jira-audit:done", { key: ticket.key });
    }
  }

  return {
    scheduleNext,
    stopPolling,
    pollOnce,
    getCurrentTask: () => currentTask,
    isRunning: () => pollingTimer !== null,
  };
}
