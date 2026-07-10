import { adapters, getAdapter } from "./adapters.js";
import type { Config } from "./config.js";
import { CliError, shellQuote } from "./util.js";

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
 * Complete environment for a context: every managed variable is cleared first,
 * then the context's accounts are applied. An omitted adapter therefore never
 * inherits whatever happened to be exported in the calling shell.
 */
export function envForContext(config: Config, contextName: string): EnvOverrides {
  const context = config.contexts[contextName];
  if (!context) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context: ${contextName}\nKnown contexts: ${known}`);
  }

  const env: EnvOverrides = {};
  for (const name of allManagedVars()) env[name] = null;

  for (const id of context.accounts) {
    const account = config.accounts[id];
    if (!account) throw new CliError(`Context '${contextName}' references unknown account '${id}'.`);
    Object.assign(env, getAdapter(account.adapter).envFor(account));
  }

  env.AGENTCTX_CONTEXT = contextName;
  return env;
}

/** Environment that removes every trace of agentctx from a shell. */
export function clearedEnv(): EnvOverrides {
  const env: EnvOverrides = {};
  for (const name of allManagedVars()) env[name] = null;
  env.AGENTCTX_CONTEXT = null;
  env.AGENTCTX_OVERRIDE = null;
  env.AGENTCTX_BOUND_DIR = null;
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
