import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AccountConfig } from "./adapters.js";
import { getAdapter } from "./adapters.js";
import { allManagedVars, applyEnv, type EnvOverrides } from "./env.js";

export interface IdentityResult {
  ok: boolean;
  summary: string;
}

function isExecutableFile(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const installedCache = new Map<string, boolean>();

/**
 * Resolve a command against PATH ourselves. Shelling out to `which` costs a
 * process per call (several per account in doctor/login) and is not universally
 * present — Debian 13 dropped it from debianutils, where every adapter would
 * then report "not installed". Memoized: PATH cannot change mid-process.
 */
export function cliInstalled(cli: string): boolean {
  const cached = installedCache.get(cli);
  if (cached !== undefined) return cached;

  let found: boolean;
  if (cli.includes(path.sep)) {
    found = isExecutableFile(path.resolve(cli));
  } else {
    found = (process.env.PATH ?? "")
      .split(path.delimiter)
      .some((dir) => dir !== "" && isExecutableFile(path.join(dir, cli)));
  }
  installedCache.set(cli, found);
  return found;
}

/** Every managed variable cleared, then just this account's own selectors. */
export function identityEnv(account: AccountConfig): EnvOverrides {
  const overrides: EnvOverrides = {};
  for (const name of allManagedVars()) overrides[name] = null;
  if (!account.system) Object.assign(overrides, getAdapter(account.adapter).envFor(account));
  return overrides;
}

/**
 * Ask the provider CLI "who am I" under this account's isolated environment.
 * All managed variables are cleared first so the answer cannot leak in from the
 * shell. Async so callers with many accounts (doctor) can probe concurrently —
 * these are network round trips, and serial they dominate the command.
 */
export function runIdentity(account: AccountConfig): Promise<IdentityResult> {
  const adapter = getAdapter(account.adapter);
  const spec = adapter.identity?.(account);
  if (!spec) return Promise.resolve({ ok: true, summary: "no identity check for this adapter" });

  if (!cliInstalled(adapter.cli)) {
    return Promise.resolve({ ok: false, summary: `${adapter.cli} is not installed (or not on PATH)` });
  }

  return new Promise((resolve) => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      env: applyEnv(process.env, identityEnv(account)),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ ok: false, summary: error.message }));
    child.on("close", (status) => resolve(spec.parse(stdout, stderr, status)));
  });
}

/**
 * Probe a set of accounts at once. Deduplicated by id: one account shared by
 * five contexts is one probe, not five.
 */
export async function probeIdentities(
  accounts: Array<{ id: string; account: AccountConfig }>
): Promise<Map<string, IdentityResult>> {
  const unique = new Map<string, AccountConfig>();
  for (const { id, account } of accounts) unique.set(id, account);

  const ids = [...unique.keys()];
  const results = await Promise.all(ids.map((id) => runIdentity(unique.get(id)!)));
  return new Map(ids.map((id, index) => [id, results[index]]));
}
