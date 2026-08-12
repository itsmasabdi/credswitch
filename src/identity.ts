import { spawnSync } from "node:child_process";
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

/**
 * Ask the provider CLI "who am I" under this account's isolated environment.
 * All managed variables are cleared first so the answer cannot leak in from the shell.
 */
export function runIdentity(account: AccountConfig): IdentityResult {
  const adapter = getAdapter(account.adapter);
  const spec = adapter.identity?.(account);
  if (!spec) return { ok: true, summary: "no identity check for this adapter" };

  if (!cliInstalled(adapter.cli)) {
    return { ok: false, summary: `${adapter.cli} is not installed (or not on PATH)` };
  }

  const overrides: EnvOverrides = {};
  for (const name of allManagedVars()) overrides[name] = null;
  if (!account.system) Object.assign(overrides, adapter.envFor(account));

  const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
    env: applyEnv(process.env, overrides),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000
  });

  if (result.error) return { ok: false, summary: result.error.message };
  return spec.parse(result.stdout ?? "", result.stderr ?? "", result.status);
}
