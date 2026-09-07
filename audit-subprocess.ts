import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXTENSION_DIR, USER_AGENTS_DIR } from "./config";
import { buildAuditTask, buildAuditThread, extractDescriptionText } from "./audit-prompt";
import type { JiraComment } from "./jira-client";
import { clearCurrentProc, killProcessTree, setCurrentProc } from "./process-tree";

export interface AuditResult {
  key: string;
  summary: string;
  output: string;
  exitCode: number;
  error?: string;
}

/**
 * Resolve the correct pi binary to spawn.
 * In bun: process.argv = [bun, script, ...]
 * In node: process.argv = [node, script, ...]
 * We detect bun's virtual script path and fall back to searching PATH.
 */
function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...extraArgs] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: extraArgs };
  }
  return { command: "pi", args: extraArgs };
}

/**
 * Spawn a read-only pi subprocess for the audit agent.
 * Returns the final output text (what the agent said).
 * The agent has only: read, grep, find, ls, bash.
 */
export async function runAuditSubprocess(
  issueKey: string,
  issueSummary: string,
  issueDescription: unknown,
  existingComments: JiraComment[],
  model: string | undefined,
  signal: AbortSignal,
  onStatus: (msg: string) => void,
  log: (msg: string) => void,
  codebaseRoot: string,
): Promise<AuditResult> {
  const descText = extractDescriptionText(issueDescription);
  const auditThread = buildAuditThread(existingComments);
  const task = buildAuditTask(issueKey, issueSummary, descText, auditThread, codebaseRoot);

  // Build agent system prompt from audit.md.  Resolution order:
  //   1. ~/.pi/agent/agents/audit.md — user override
  //   2. <extension-dir>/agents/audit.md — baked-in default shipped with the extension
  const userAuditPath = path.join(USER_AGENTS_DIR, "audit.md");
  const bakedAuditPath = path.join(EXTENSION_DIR, "agents", "audit.md");
  const auditAgentPath = fs.existsSync(userAuditPath) ? userAuditPath : bakedAuditPath;
  let agentSystemPrompt = "You are a read-only code auditor. Use read, grep, find, and ls only.";
  if (fs.existsSync(auditAgentPath)) {
    const raw = fs.readFileSync(auditAgentPath, "utf-8");
    const body = raw.replace(/^---[\s\S]*?---\n?/, "").trim();
    if (body) agentSystemPrompt = body;
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jira-audit-"));
  const systemPromptFile = path.join(tmpDir, "system-prompt.md");
  await fs.promises.writeFile(systemPromptFile, agentSystemPrompt, { encoding: "utf-8" });

  return new Promise<AuditResult>((resolve) => {
    const invocationArgs: string[] = [
      "--mode", "json", "-p", "--no-session",
      "--tools", "read,grep,find,ls,bash",
      "--append-system-prompt", systemPromptFile,
    ];
    if (model) invocationArgs.push("--model", model);
    invocationArgs.push(task);
    const invocation = getPiInvocation(invocationArgs);

    onStatus(`[${issueKey}] Spawning audit agent...`);

    const proc = spawn(invocation.command, invocation.args, {
      cwd: codebaseRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group → tool subprocesses die with us
    });
    setCurrentProc(proc);

    let buffer = "";
    const messages: unknown[] = [];
    let stderr = "";
    let exitCode = 0;

    // Hard timeout (default 15 min — big audits over a large codebase are slow)
    const timeoutMs = (process.env.JIRA_AUDIT_TIMEOUT_SECS
      ? parseInt(process.env.JIRA_AUDIT_TIMEOUT_SECS, 10)
      : 15 * 60) * 1000;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => {
      if (killTimer) clearTimeout(killTimer);
      killProcessTree(proc, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), 5000);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      fs.unlink(systemPromptFile, () => {});
      fs.rm(tmpDir, { recursive: true }, () => {});
    };

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: { type: string; message?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type !== "message_end" || !event.message) continue;
        messages.push(event.message);
        const msg = event.message as { role?: string; content?: unknown[] };

        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

        let showedToolCall = false;
        for (const part of msg.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "toolCall"
          ) {
            const call = part as { name?: string; arguments?: Record<string, unknown> };
            const a = call.arguments ?? {};
            const target =
              (a.path as string) ??
              (a.file_path as string) ??
              (a.pattern as string) ??
              (a.command as string)?.slice(0, 60) ??
              "";
            onStatus(`[${issueKey}] ${call.name ?? "tool"} ${target}`.trim());
            showedToolCall = true;
          }
        }
        if (showedToolCall) continue;

        for (const part of msg.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "text"
          ) {
            const text = (part as { type: string; text: string }).text;
            if (text.length > 0) {
              onStatus(
                `[${issueKey}] Audit in progress: ${text.slice(-200).replace(/\n/g, " ")}`,
              );
            }
          }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      cleanup();
      clearCurrentProc(proc);
      exitCode = code ?? 0;

      let output = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as { role?: string; content?: unknown[] };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
        for (const part of msg.content) {
          if (
            part &&
            typeof part === "object" &&
            (part as { type?: string }).type === "text"
          ) {
            output = (part as { type: string; text: string }).text;
            break;
          }
        }
        if (output) break;
      }

      resolve({
        key: issueKey,
        summary: issueSummary,
        output,
        exitCode,
        error: stderr || undefined,
      });
    });

    proc.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      cleanup();
      clearCurrentProc(proc);
      resolve({
        key: issueKey,
        summary: issueSummary,
        output: "",
        exitCode: 1,
        error: err.message,
      });
    });

    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      killProcessTree(proc, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(proc, "SIGKILL"), 5000);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
