# PI Jira Audit Runner

A [pi](https://github.com/earendil-works/pi) extension that polls Jira for tickets
with the "Run audit" trigger and spawns a read-only audit agent for each one,
posting the result back as a Jira comment.

```
+----------+        +----------------+        +-------------------+
|   Jira   |  poll  |  this runner   | spawn  |  pi audit agent   |
|  /rest   | <----- |  (extension)   | -----> |  (subprocess)     |
+----------+  JQL   +----------------+        +-------------------+
                |                                |
                +-- post audit comment           +-- runs read, grep,
                                                    find, ls, bash
                                                    (bash for npx jscpd)
```

## Install

```bash
# 1. Clone this repo somewhere pi's auto-discovery can reach.
#    For a global install, symlink it into ~/.pi/agent/extensions/:
ln -s "$(pwd)" ~/.pi/agent/extensions/jira-audit-runner

# 2. Set up credentials — pick ONE option below.
# 3. Restart pi (or /reload) so it picks up the new extension.
```

## Configuration

Credentials resolve in this priority order (highest first):

| Priority | Source                                                       | Use case                              |
|---------:|--------------------------------------------------------------|---------------------------------------|
| 1        | `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` env vars   | CI, dev shell, one-off                |
| 2        | `<repo>/config.local.json` (gitignored)                      | Self-contained per-machine install    |
| 3        | `~/.pi/sf/atlassian/config.json`                             | Shared with other Atlassian tools     |

All three are required. There is no default tenant URL — the runner refuses
to start if `JIRA_BASE_URL` is empty. No credentials are committed to this repo.
Copy the template to get started:

```bash
cp config.local.example.json config.local.json
# edit config.local.json — baseUrl, email, apiToken
```

Generate an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

The audit field defaults to `customfield_10318` (a multicheckbox accepting
`"true"` for an initial request and `"1"`/`"2"`/`"3"` for retries); pass
`auditField=<id>` on `/jira-audit-runner on` to override.

## Commands

```text
/jira-audit-runner on   [project=KAN] [interval=300] [auditField=10318]
/jira-audit-runner off
/jira-audit-runner status
```

Default interval is 300s (5 min). The runner is opt-in per session — re-enable
after `/reload` or a new session.

## Lifecycle

The audit subprocess is spawned with `detached: true` so it owns its own
process group. On shutdown — `SIGINT` (Cmd+C), `SIGTERM`, `beforeExit`, `exit`,
or pi's `session_shutdown` — the whole group is signalled (SIGTERM with
SIGKILL escalation: 2s grace on shutdown, 5s on the subprocess abort/timeout
paths) so `pi -p` and any tool subprocesses it spawned (bash, npx, jscpd) all
die together. Without this they would survive and get reparented to launchd.

## Architecture

```
jira-audit-runner/
├── index.ts             # Extension entry: command registration, shutdown hooks
├── runner.ts            # Polling state machine (createRunner factory)
├── state.ts             # RunnerState + persistent JSON load/save
├── config.ts            # Paths, env vars, credential resolution
├── jira-client.ts       # HTTP client + Jira operations + types
├── markdown.ts          # MD → Atlassian Document Format converter
├── audit-prompt.ts      # Build the audit task from Jira data
├── audit-subprocess.ts  # Spawn & manage the audit subprocess
├── process-tree.ts      # Process-group lifecycle helpers
├── agents/
│   └── audit.md         # Baked-in audit agent system prompt
├── config.local.example.json
├── .gitignore
└── README.md
```

Dependency DAG (no cycles):

```
config, markdown  →  state, jira-client
                          ↓
                     audit-prompt → audit-subprocess → runner → index
                                  ↘              ↗
                              process-tree
```

## State file

Persisted at `~/.pi/agent/extensions/jira-audit-runner-state.json`. Contains
the last-used `project`, `intervalSecs`, `auditFieldId`, `model`, and the
`processedKeys` dedup set. Survives restarts. `processedKeys` is cleared on
`session_shutdown` so the next session starts fresh.

## Development

The repo is the canonical source — `~/.pi/agent/extensions/jira-audit-runner`
is a symlink to it, so edits here are picked up after `/reload` (or restart).
Do not edit files under `~/.pi/agent/extensions/` directly; the symlink is
the only place the files actually live.

The audit agent prompt at `agents/audit.md` is baked into the repo and used
by default. To customize it locally without affecting the repo, copy it to
`~/.pi/agent/agents/audit.md` — the runner picks up the user copy when
present and falls back to the baked-in one otherwise.
