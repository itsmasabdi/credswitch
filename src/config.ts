import fs from "node:fs";
import path from "node:path";
import { adapters, getAdapter, type AccountConfig } from "./adapters.js";
import { bindingsListPath, configPath } from "./paths.js";
import { atomicWrite, CliError, withLock } from "./util.js";

export interface ContextConfig {
  description?: string;
  accounts: string[];
}

export interface Config {
  version: 2;
  /** Monotonic save counter; the hook uses it to notice config changes. */
  gen?: number;
  defaultContext?: string;
  accounts: Record<string, AccountConfig>;
  contexts: Record<string, ContextConfig>;
  bindings: Record<string, string>;
}

export const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CONTEXT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function emptyConfig(): Config {
  return { version: 2, accounts: {}, contexts: {}, bindings: {} };
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

export function loadConfig(): Config {
  const target = configPath();
  if (!fs.existsSync(target)) {
    throw new CliError(`Missing config: ${target}\nRun 'csw init' to create one.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw new CliError(`Could not parse ${target}: ${(error as Error).message}`);
  }

  const config = normalize(parsed, target);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new CliError(`Invalid config: ${target}\n  - ${errors.join("\n  - ")}`);
  }
  return config;
}

function normalize(parsed: unknown, target: string): Config {
  if (!parsed || typeof parsed !== "object") {
    throw new CliError(`Invalid config: ${target}\nExpected a JSON object.`);
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 2) {
    throw new CliError(`Invalid config: ${target}\nExpected "version": 2.`);
  }
  return {
    version: 2,
    gen: typeof raw.gen === "number" ? raw.gen : 0,
    defaultContext: typeof raw.defaultContext === "string" ? raw.defaultContext : undefined,
    accounts: (raw.accounts as Record<string, AccountConfig>) ?? {},
    contexts: (raw.contexts as Record<string, ContextConfig>) ?? {},
    bindings: (raw.bindings as Record<string, string>) ?? {}
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  for (const [id, account] of Object.entries(config.accounts)) {
    if (!ACCOUNT_ID_RE.test(id)) {
      errors.push(`account id '${id}' must look like <adapter>:<name> (e.g. azure:work)`);
      continue;
    }
    const prefix = id.split(":")[0];
    if (!adapters[prefix]) {
      errors.push(`account '${id}': unknown adapter '${prefix}'`);
      continue;
    }
    if (account.adapter !== prefix) {
      errors.push(`account '${id}': adapter field '${account.adapter}' does not match id prefix '${prefix}'`);
      continue;
    }
    const issue = getAdapter(prefix).validateAccount(account);
    if (issue) errors.push(`account '${id}': ${issue}`);
  }

  for (const [name, context] of Object.entries(config.contexts)) {
    if (!CONTEXT_NAME_RE.test(name)) {
      errors.push(`context name '${name}' contains invalid characters`);
      continue;
    }
    if (!Array.isArray(context.accounts)) {
      errors.push(`context '${name}': 'accounts' must be an array of account ids`);
      continue;
    }
    const seenAdapters = new Map<string, string>();
    for (const id of context.accounts) {
      if (!config.accounts[id]) {
        errors.push(`context '${name}': unknown account '${id}'`);
        continue;
      }
      const adapter = id.split(":")[0];
      const existing = seenAdapters.get(adapter);
      if (existing) {
        errors.push(`context '${name}': both '${existing}' and '${id}' use adapter '${adapter}' — one identity per adapter per context`);
      }
      seenAdapters.set(adapter, id);
    }
  }

  for (const [dir, contextName] of Object.entries(config.bindings)) {
    if (!path.isAbsolute(dir)) errors.push(`binding '${dir}': must be an absolute path`);
    if (/[\t\n]/.test(dir)) errors.push(`binding '${dir}': path must not contain tabs or newlines`);
    if (!config.contexts[contextName]) errors.push(`binding '${dir}': unknown context '${contextName}'`);
  }

  if (config.defaultContext && !config.contexts[config.defaultContext]) {
    errors.push(`defaultContext '${config.defaultContext}' does not exist`);
  }

  return errors;
}

export function saveConfig(config: Config): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new CliError(`Refusing to save invalid config:\n  - ${errors.join("\n  - ")}`);
  }
  config.gen = (config.gen ?? 0) + 1;
  // List first: if we crash between the writes, the hook over-asks the
  // resolver (safe) rather than missing a binding transition (stale creds).
  // The gen race (list ahead of config) self-heals because `csw env` stamps
  // CREDSWITCH_HOOK_KEY with the gen of the config it actually read.
  writeBindingsList(config);
  atomicWrite(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Hold the config lock while applying a read-modify-write. All mutating
 * commands go through here so concurrent agents cannot lose updates.
 */
export function mutateConfig(mutator: (config: Config) => void): Config {
  return withLock(`${configPath()}.lock`, () => {
    const config = loadConfig();
    mutator(config);
    saveConfig(config);
    return config;
  });
}

/** Regenerate the "dir<TAB>context" list consumed by the shell hook's fast path. */
export function writeBindingsList(config: Config): void {
  const entries = Object.entries(config.bindings)
    .map(([dir, ctx]) => `${dir}\t${ctx}`)
    .sort();
  // The #gen stamp changes on every save, so open shells re-apply their env
  // at the next prompt after ANY config change, not just binding transitions.
  const lines = [`#gen\t${config.gen ?? 0}`, ...entries];
  atomicWrite(bindingsListPath(), `${lines.join("\n")}\n`);
}
