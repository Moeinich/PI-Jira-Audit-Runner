import type { JiraComment } from "./jira-client";

export function extractDescriptionText(desc: unknown): string {
  if (!desc || typeof desc !== "object") return "";
  const doc = desc as { content?: unknown[] };
  if (!Array.isArray(doc.content)) return "";
  const texts: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === "text" && typeof n.text === "string") texts.push(n.text);
      if (Array.isArray(n.content)) walk(n.content);
    }
  };
  walk(doc.content);
  return texts.join(" ");
}

export function extractCommentBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    try {
      return JSON.stringify(body).replace(/<[^>]+>/g, "").trim();
    } catch {
      return String(body);
    }
  }
  return String(body ?? "");
}

export function buildAuditThread(comments: JiraComment[]): string {
  if (!comments.length) return "";
  const lines: string[] = ["## Prior audit comments on this ticket\n"];
  for (const c of comments) {
    const date = new Date(c.created).toLocaleDateString("da-DK");
    const body = extractCommentBody(c.body);
    if (!body) continue;
    lines.push(`**${c.author.displayName}** (${date}):\n${body}\n`);
  }
  return lines.join("\n") + "\n";
}

export function buildAuditTask(
  issueKey: string,
  issueSummary: string,
  descText: string,
  auditThread: string,
  codebaseRoot: string,
): string {
  return `You are auditing Jira ticket **${issueKey}**: "${issueSummary}".

${descText ? `## Ticket description\n${descText}\n\n` : ""}${auditThread}## Your task
Audit the implementation of this ticket against the codebase at ${codebaseRoot}.

Focus on:
1. **Implementation correctness** — does the code do what the ticket describes?
2. **Bugs and edge cases** — missing validations, unhandled states, potential crashes?
3. **Consistency** — code style, naming, patterns: does it match the rest of the codebase?
4. **Security** — auth bypasses, injection vectors, data exposure?
5. **Performance** — N+1 queries, missing indices, expensive operations on hot paths?
6. **Refactoring opportunities** — is any touched code harder to extend than it should be? Is there a pattern you would introduce to make the system more maintainable? Look at related code in the same feature and adjacent features for shared abstractions worth extracting.

Cite specific file paths and line numbers. Do NOT write any code. Do NOT edit any files. Do NOT run any bash commands. Only read, grep, find, and ls.

Format your response as a clear markdown report with these sections:

## Implementation Summary
[one paragraph: what was implemented and how]

## Findings
[numbered list, one per finding]

## Refactoring Opportunities
[bullet list of architectural or code-quality improvements, if any — be specific about what to change and why]

## Verdict
[one paragraph: overall quality rating and key recommendation]`;
}
