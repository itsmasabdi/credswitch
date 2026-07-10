import { spawnSync } from "node:child_process";
import type { AccountConfig } from "./adapters.js";
import { getAdapter } from "./adapters.js";
import { allManagedVars, applyEnv, type EnvOverrides } from "./env.js";

export interface IdentityResult {
  ok: boolean;
  summary: string;
}

export function cliInstalled(cli: string): boolean {
  const result = spawnSync("which", [cli], { stdio: "ignore" });
  return result.status === 0;
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
  Object.assign(overrides, adapter.envFor(account));

  const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
    env: applyEnv(process.env, overrides),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000
  });

  if (result.error) return { ok: false, summary: result.error.message };
  return spec.parse(result.stdout ?? "", result.stderr ?? "", result.status);
}
