import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Path to this extension's directory.  jiti loads TS via a CJS transform
// where import.meta.url can be undefined; fall back to the well-known global
// install location so the extension still loads there.
function resolveExtensionDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return path.join(os.homedir(), ".pi/agent/extensions/jira-audit-runner");
  }
}
export const EXTENSION_DIR = resolveExtensionDir();
export const STATE_FILE = path.join(
  os.homedir(),
  ".pi/agent/extensions/jira-audit-runner-state.json",
);
// User-overridable agent directory: when present, audit.md here overrides
// the baked-in copy shipped with the extension.
export const USER_AGENTS_DIR = path.join(os.homedir(), ".pi/agent/agents");

export interface AtlassianConfig {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
}

function readConfigFile(filePath: string): AtlassianConfig {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AtlassianConfig;
    }
  } catch {
    /* not found or corrupt */
  }
  return {};
}

/**
 * Resolve credentials in priority order:
 *   1. Environment variables (JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN)
 *   2. <extension-dir>/config.local.json — checked into .gitignore, for
 *      self-contained installs that don't want a global atlassian config
 *   3. ~/.pi/sf/atlassian/config.json — legacy global location shared with
 *      other Atlassian tools (MCP, etc.)
 */
function loadAtlassianConfig(): AtlassianConfig {
  const localPath = path.join(EXTENSION_DIR, "config.local.json");
  const globalPath = path.join(os.homedir(), ".pi/sf/atlassian/config.json");
  return { ...readConfigFile(globalPath), ...readConfigFile(localPath) };
}

const atlassianConfig = loadAtlassianConfig();
// No defaults — must be set explicitly via env or config.local.json. Do
// not hardcode tenant URLs here; this file is shared.
export const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? atlassianConfig.baseUrl ?? "";
export const JIRA_EMAIL = process.env.JIRA_EMAIL ?? atlassianConfig.email;
export const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN ?? atlassianConfig.apiToken;

// Path the audit subprocess runs in (its cwd) and the path mentioned in the
// audit prompt.  Override via env var; defaults to whatever directory pi
// was launched from, which is normally the repo being audited.
export const CODEBASE_ROOT = process.env.JIRA_AUDIT_CODEBASE_ROOT ?? process.cwd();
