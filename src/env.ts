import fs from "node:fs";
import { adapters, getAdapter } from "./adapters.js";
import type { Config } from "./config.js";
import { deniedRoot, stateRoot } from "./paths.js";
import { CliError, ensureDir, shellQuote } from "./util.js";

/** Values of `null` mean "unset this variable". */
export type EnvOverrides = Record<string, string | null>;

export function allManagedVars(): string[] {
  const vars = new Set<string>();
  for (const adapter of Object.values(adapters)) {
    for (const name of adapter.managedEnv) vars.add(name);
  }
  return [...vars].sort();
}

/**
 * Create the denied root as a read-only directory. Denied selectors point at
 * children of it, so no provider CLI can ever create or persist state there.
 */
function ensureDeniedRoot(): void {
  try {
    ensureDir(stateRoot());
    const root = deniedRoot();
    if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o500 });
    else fs.chmodSync(root, 0o500);
  } catch {
    // Even if this fails, denied selectors point at nonexistent paths — still closed.
  }
}

/**
 * Complete environment for a context:
 * 1. every managed credential channel of every adapter is cleared;
 * 2. adapters the context omits are DENIED — selectors point into the
 *    read-only denied root, so their CLIs report not-logged-in instead of
 *    silently using the machine default;
 * 3. the context's accounts are applied (system accounts leave their
 *    adapter's variables unset — the explicit machine default).
 */
export function envForContext(config: Config, contextName: string): EnvOverrides {
  const context = config.contexts[contextName];
  if (!context) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context: ${contextName}\nKnown contexts: ${known}`);
  }

  const env: EnvOverrides = {};
  for (const name of allManagedVars()) env[name] = null;

  const present = new Set(context.accounts.map((id) => config.accounts[id]?.adapter));
  const denied = deniedRoot();
  let anyDenied = false;
  for (const [name, adapter] of Object.entries(adapters)) {
    if (!present.has(name)) {
      Object.assign(env, adapter.deniedEnv(denied));
      anyDenied = true;
    }
  }
  if (anyDenied) ensureDeniedRoot();

  for (const id of context.accounts) {
    const account = config.accounts[id];
    if (!account) throw new CliError(`Context '${contextName}' references unknown account '${id}'.`);
    if (!account.system) Object.assign(env, getAdapter(account.adapter).envFor(account));
  }

  env.CREDSWITCH_CONTEXT = contextName;
  return env;
}

/** Adapters a context does not include (and therefore denies). */
export function deniedAdapters(config: Config, contextName: string): string[] {
  const context = config.contexts[contextName];
  if (!context) return [];
  const present = new Set(context.accounts.map((id) => config.accounts[id]?.adapter));
  return Object.keys(adapters).filter((name) => !present.has(name)).sort();
}

/** Environment that removes every trace of credswitch from a shell. */
export function clearedEnv(): EnvOverrides {
  const env: EnvOverrides = {};
  for (const name of allManagedVars()) env[name] = null;
  env.CREDSWITCH_CONTEXT = null;
  env.CREDSWITCH_OVERRIDE = null;
  env.CREDSWITCH_BOUND_DIR = null;
  env.CREDSWITCH_HOOK_KEY = null;
  return env;
}

export function applyEnv(base: NodeJS.ProcessEnv, overrides: EnvOverrides): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Render overrides as eval-able POSIX shell lines. */
export function shellLines(overrides: EnvOverrides): string[] {
  return Object.keys(overrides)
    .sort()
    .map((key) => {
      const value = overrides[key];
      return value === null ? `unset ${key}` : `export ${key}=${shellQuote(value)}`;
    });
}
