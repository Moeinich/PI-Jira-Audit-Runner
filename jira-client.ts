import * as https from "node:https";
import { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } from "./config";
import { mdToAdf } from "./markdown";

export interface JiraComment {
  id: string;
  body: unknown;
  created: string;
  author: { displayName: string };
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    comment?: { comments: JiraComment[] };
    [key: string]: unknown;
  };
}

export interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
  isLast?: boolean;
  nextPageToken?: string;
}

export async function jiraRequest<T = void>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathAndQuery: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (!JIRA_BASE_URL) {
    throw new Error(
      "JIRA_BASE_URL is not set (env JIRA_BASE_URL or config.local.json baseUrl)",
    );
  }
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      "JIRA_EMAIL and JIRA_API_TOKEN environment variables are required",
    );
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const url = new URL(pathAndQuery, JIRA_BASE_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode !== undefined && res.statusCode >= 400) {
          reject(new Error(`Jira API ${res.statusCode}: ${data}`));
          return;
        }
        if (!data) {
          resolve(undefined as T);
          return;
        }
        try {
          resolve(JSON.parse(data) as T);
        } catch {
          reject(new Error(`Failed to parse Jira response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
    if (signal) {
      signal.addEventListener(
        "abort",
        () => req.destroy(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }
  });
}

export async function addJiraComment(
  issueKey: string,
  body: string,
  signal?: AbortSignal,
): Promise<void> {
  await jiraRequest(
    "POST",
    `/rest/api/3/issue/${issueKey}/comment`,
    {
      body: {
        version: 1,
        type: "doc",
        content: mdToAdf(body),
      },
    },
    signal,
  );
}

export async function markTicketProcessed(
  issueKey: string,
  auditFieldId: number,
  fieldValue: "true" | "1" | "2" | "3" | null,
  signal?: AbortSignal,
): Promise<void> {
  const fieldKey = `customfield_${auditFieldId}`;
  const payload = fieldValue
    ? { fields: { [fieldKey]: [{ value: fieldValue }] } }
    : { fields: { [fieldKey]: [] } };
  await jiraRequest("PUT", `/rest/api/3/issue/${issueKey}`, payload, signal);
}

export function nextRetryValue(
  current: "true" | "1" | "2" | "3" | null,
): "1" | "2" | "3" | null {
  if (current === "true" || current === null) return "1";
  if (current === "1") return "2";
  if (current === "2") return "3";
  return null;
}

export function readOption(
  issue: JiraIssue,
  auditFieldId: number,
): "true" | "1" | "2" | "3" | null {
  const opts = (issue.fields as Record<string, unknown>)?.[`customfield_${auditFieldId}`];
  if (!Array.isArray(opts)) return null;
  const v = opts[0]?.value;
  return v === "true" || v === "1" || v === "2" || v === "3" ? v : null;
}

export async function fetchTriggeredTickets(
  project: string,
  auditFieldId: number,
  signal: AbortSignal,
): Promise<JiraIssue[]> {
  const jql =
    `project = ${project} AND cf[${auditFieldId}] in ("true","1","2","3") ORDER BY updated ASC`;

  let allIssues: JiraIssue[] = [];
  let token: string | undefined;
  const maxResults = 50;

  while (true) {
    const result = await jiraRequest<JiraSearchResult>(
      "POST",
      `/rest/api/3/search/jql?maxResults=${maxResults}`,
      { jql, maxResults, nextPageToken: token, fields: ["key", "summary", "description", "comment"] },
      signal,
    );
    allIssues = allIssues.concat(result.issues);
    token = result.nextPageToken;

    if (signal.aborted || result.isLast || !result.nextPageToken) break;
  }

  return allIssues;
}
