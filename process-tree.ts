import type { ChildProcess } from "node:child_process";

let currentProc: ChildProcess | null = null;

export function setCurrentProc(proc: ChildProcess | null): void {
  currentProc = proc;
}

export function clearCurrentProc(proc: ChildProcess): void {
  if (currentProc === proc) currentProc = null;
}

export function getCurrentProc(): ChildProcess | null {
  return currentProc;
}

/**
 * Signal the subprocess AND every descendant in its process group.  The
 * audit subprocess is spawned with `detached: true` so it leads its own
 * group — `pi -p` and any tool subprocesses (bash, npx, jscpd) it spawns
 * are all killed together.  Falls back to direct kill if the group is gone.
 */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
