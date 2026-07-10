import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { adapterNames, getAdapter, type AccountConfig } from "./adapters.js";
import {
  configExists,
  emptyConfig,
  loadConfig,
  mutateConfig,
  saveConfig,
  writeBindingsList,
  type Config
} from "./config.js";
import {
  allManagedVars,
  applyEnv,
  clearedEnv,
  deniedAdapters,
  envForContext,
  shellLines,
  type EnvOverrides
} from "./env.js";
import { bashHook, zshHook } from "./hooks.js";
import { cliInstalled, runIdentity } from "./identity.js";
import { configPath, stateRoot } from "./paths.js";
import { describeSource, resolveContext } from "./resolver.js";
import {
  ACCOUNT_NAME_RE,
  CliError,
  ensureDir,
  expandPath,
  parseArgs,
  realpathSafe,
  redactHome
} from "./util.js";

// ---------------------------------------------------------------------------
// init

export function cmdInit(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length > 0) throw new CliError("Usage: csw init");
  if (configExists()) {
    console.log(`Config already exists: ${redactHome(configPath())}`);
    return;
  }
  saveConfig(emptyConfig());
  console.log(`Created ${redactHome(configPath())}`);
  console.log(`
Quickstart:
  csw account add azure --name work            # fresh isolated login (launches 'az login')
  csw account add claude --system              # use your existing default Claude Code login
  csw context add work azure:work claude:default
  csw bind work --dir ~/Projects/work          # this folder tree now selects 'work'
  eval "$(csw hook zsh)"                       # add to ~/.zshrc for automatic switching
  csw run -- az account show                   # or run one command in the resolved context`);
}

// ---------------------------------------------------------------------------
// account

export function cmdAccount(args: string[]): void {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return accountAdd(rest);
    case "list":
      return accountList(rest);
    case "remove":
      return accountRemove(rest);
    case "pin":
      return accountPin(rest);
    case "login":
      return accountLogin(rest);
    default:
      throw new CliError("Usage: csw account <add|list|remove|pin|login> ...");
  }
}

function loginEnvFor(account: AccountConfig): EnvOverrides {
  const overrides: EnvOverrides = {};
  for (const name of allManagedVars()) overrides[name] = null;
  if (!account.system) Object.assign(overrides, getAdapter(account.adapter).envFor(account));
  return overrides;
}

function accountAdd(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: {
      "--name": "name",
      "--path": "path",
      "--kubeconfig": "kubeconfig",
      "--context": "context",
      "-c": "context"
    },
    boolFlags: { "--system": "system", "--no-login": "noLogin" }
  });

  if (pos.length !== 1) {
    throw new CliError(
      "Usage: csw account add <adapter> --name <name> [--path <dir>] [--kubeconfig <file>] [--system] [--context <ctx>] [--no-login]\n" +
        `Adapters: ${adapterNames().join(", ")}`
    );
  }

  const adapter = getAdapter(pos[0]);
  const name = (opts.name as string | undefined) ?? (opts.system ? "default" : undefined);
  if (!name) throw new CliError("Missing --name <name> (e.g. --name work).");
  // Validate before ANY filesystem use — the name becomes a state path segment.
  if (!ACCOUNT_NAME_RE.test(name)) {
    throw new CliError(`Invalid account name '${name}'. Use letters, digits, dots, dashes, underscores.`);
  }

  const id = `${adapter.name}:${name}`;
  const preview = loadConfig();
  if (preview.accounts[id]) {
    throw new CliError(`Account '${id}' already exists. Pick a different --name or remove it first.`);
  }

  const contextName = opts.context as string | undefined;
  if (contextName && preview.contexts[contextName]) {
    const clash = preview.contexts[contextName].accounts.find(
      (existing) => preview.accounts[existing]?.adapter === adapter.name
    );
    if (clash) {
      throw new CliError(`Context '${contextName}' already has '${clash}' — one identity per adapter per context.`);
    }
  }

  const account: AccountConfig = { adapter: adapter.name };
  let createdFreshDir: string | undefined;

  if (opts.system) {
    if (opts.path || opts.kubeconfig) throw new CliError("--system takes no --path/--kubeconfig.");
    account.system = true;
  } else if (adapter.name === "kubernetes") {
    const kubeconfig = opts.kubeconfig as string | undefined;
    if (!kubeconfig) {
      throw new CliError(
        "The kubernetes adapter references an existing kubeconfig file:\n" +
          "  csw account add kubernetes --name work --kubeconfig ~/.kube/work.yaml\n" +
          "  csw account add kubernetes --system              # machine default kubeconfig"
      );
    }
    const canonical = realpathSafe(expandPath(kubeconfig));
    if (!fs.existsSync(canonical) || !fs.statSync(canonical).isFile()) {
      throw new CliError(`kubeconfig not found: ${canonical}`);
    }
    account.kubeconfig = canonical;
  } else if (opts.path) {
    const canonical = realpathSafe(expandPath(opts.path as string));
    if (!fs.existsSync(canonical) || !fs.statSync(canonical).isDirectory()) {
      throw new CliError(`--path must be an existing directory: ${canonical}`);
    }
    account.stateDir = canonical;
  } else {
    if (!adapter.freshStateDir) {
      throw new CliError(`Adapter '${adapter.name}' cannot create fresh state; use --path, --kubeconfig, or --system.`);
    }
    const dir = adapter.freshStateDir(name);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
      throw new CliError(
        `${redactHome(dir)} already exists and is not empty.\n` +
          `Reference it explicitly instead: csw account add ${adapter.name} --name ${name} --path ${dir}`
      );
    }
    ensureDir(dir);
    account.stateDir = dir;
    createdFreshDir = dir;
  }

  // Login and verification happen BEFORE anything is saved: a cancelled or
  // failed login leaves no account, no context membership, no state dir.
  if (createdFreshDir && !opts.noLogin && adapter.loginCommand) {
    const argv = adapter.loginCommand(account);
    if (!cliInstalled(argv[0])) {
      console.log(`! ${argv[0]} is not installed — skipping login. Later: csw account login ${id}`);
    } else {
      console.log(`Launching login: ${argv.join(" ")}`);
      const result = spawnSync(argv[0], argv.slice(1), {
        env: applyEnv(process.env, loginEnvFor(account)),
        stdio: "inherit"
      });
      if (result.status !== 0) {
        fs.rmSync(createdFreshDir, { recursive: true, force: true });
        throw new CliError(`Login failed or was cancelled (exit ${result.status ?? "unknown"}). Nothing was saved.`);
      }
    }
  }

  if (adapter.identity && cliInstalled(adapter.cli)) {
    const identity = runIdentity(account);
    if (identity.ok) {
      account.pin = identity.summary;
      console.log(`  ok identity: ${identity.summary} (pinned)`);
    } else {
      console.log(`  !  identity: ${identity.summary}`);
      console.log(`     Saved anyway — log in later with: csw account login ${id}`);
    }
  }

  try {
    mutateConfig((config) => {
      if (config.accounts[id]) throw new CliError(`Account '${id}' was just created by another process.`);
      config.accounts[id] = account;
      if (contextName) {
        if (!config.contexts[contextName]) config.contexts[contextName] = { accounts: [] };
        config.contexts[contextName].accounts.push(id);
      }
    });
  } catch (error) {
    if (createdFreshDir) {
      console.error(`Note: fresh state was kept at ${redactHome(createdFreshDir)} — re-add with --path to reuse it.`);
    }
    throw error;
  }

  if (account.system) {
    console.log(`Account added: ${id} (explicit machine default — no isolated state)`);
  } else if (account.kubeconfig) {
    console.log(`Account added: ${id} (kubeconfig: ${redactHome(account.kubeconfig)})`);
  } else if (opts.path) {
    console.log(`Account added: ${id} (references existing state at ${redactHome(account.stateDir!)} — nothing was copied)`);
  } else {
    console.log(`Account added: ${id} (fresh state at ${redactHome(account.stateDir!)})`);
  }

  if (contextName) console.log(`Attached to context '${contextName}'.`);
  else console.log(`Next: csw context add <context> ${id}`);
}

function accountList(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length > 0) throw new CliError("Usage: csw account list");
  const config = loadConfig();
  const ids = Object.keys(config.accounts).sort();
  if (ids.length === 0) {
    console.log("No accounts. Add one with: csw account add <adapter> --name <name>");
    return;
  }
  for (const id of ids) {
    const account = config.accounts[id];
    console.log(`  ${id}  ${describeAccount(account)}`);
  }
}

function describeAccount(account: AccountConfig): string {
  const parts: string[] = [];
  if (account.system) parts.push("machine default");
  if (account.stateDir) parts.push(`state ${redactHome(account.stateDir)}`);
  if (account.kubeconfig) parts.push(`kubeconfig ${redactHome(account.kubeconfig)}`);
  if (account.pin) parts.push(`pinned: ${account.pin}`);
  if (account.description) parts.push(account.description);
  return parts.join(" — ");
}

function accountRemove(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw account remove <adapter>:<name>");
  const id = pos[0];

  let removed: AccountConfig | undefined;
  mutateConfig((config) => {
    if (!config.accounts[id]) throw new CliError(`Unknown account: ${id}`);
    const usedBy = Object.entries(config.contexts)
      .filter(([, ctx]) => ctx.accounts.includes(id))
      .map(([name]) => name);
    if (usedBy.length > 0) {
      throw new CliError(
        `Account '${id}' is used by context(s): ${usedBy.join(", ")}.\n` +
          `Detach it first: csw context set <name> <remaining accounts...>`
      );
    }
    removed = config.accounts[id];
    delete config.accounts[id];
  });

  console.log(`Account removed from config: ${id}`);
  if (removed?.stateDir) {
    console.log(`Credential state was NOT deleted: ${redactHome(removed.stateDir)}`);
    console.log("Delete that directory yourself if you want the credentials gone.");
  }
}

function accountPin(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw account pin <adapter>:<name>");
  const id = pos[0];
  const config = loadConfig();
  const account = config.accounts[id];
  if (!account) throw new CliError(`Unknown account: ${id}`);

  const identity = runIdentity(account);
  if (!identity.ok) throw new CliError(`Cannot pin ${id}: ${identity.summary}`);

  const previous = account.pin;
  mutateConfig((c) => {
    if (!c.accounts[id]) throw new CliError(`Unknown account: ${id}`);
    c.accounts[id].pin = identity.summary;
  });
  if (previous && previous !== identity.summary) {
    console.log(`Re-pinned ${id}:\n  was: ${previous}\n  now: ${identity.summary}`);
  } else {
    console.log(`Pinned ${id}: ${identity.summary}`);
  }
}

function accountLogin(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw account login <adapter>:<name>");
  const id = pos[0];
  const config = loadConfig();
  const account = config.accounts[id];
  if (!account) throw new CliError(`Unknown account: ${id}`);

  const adapter = getAdapter(account.adapter);
  if (!adapter.loginCommand) {
    throw new CliError(`Adapter '${adapter.name}' has no login command — use the provider's own tooling.`);
  }
  const argv = adapter.loginCommand(account);
  if (!cliInstalled(argv[0])) throw new CliError(`${argv[0]} is not installed (or not on PATH).`);

  console.log(`Launching login: ${argv.join(" ")}`);
  const result = spawnSync(argv[0], argv.slice(1), {
    env: applyEnv(process.env, loginEnvFor(account)),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new CliError(`Login failed or was cancelled (exit ${result.status ?? "unknown"}).`);
  }

  const identity = runIdentity(account);
  if (identity.ok) {
    mutateConfig((c) => {
      if (c.accounts[id]) c.accounts[id].pin = identity.summary;
    });
    console.log(`  ok identity: ${identity.summary} (pinned)`);
  } else {
    console.log(`  !  identity: ${identity.summary}`);
  }
}

// ---------------------------------------------------------------------------
// context

export function cmdContext(args: string[]): void {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return contextAdd(rest);
    case "set":
      return contextSet(rest);
    case "remove":
      return contextRemove(rest);
    default:
      throw new CliError("Usage: csw context <add|set|remove> ...");
  }
}

function contextAdd(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--description": "description", "-d": "description" }
  });
  if (pos.length < 2) {
    throw new CliError("Usage: csw context add <name> <adapter>:<account> [...more] [--description <text>]");
  }
  const [name, ...accountIds] = pos;

  const config = mutateConfig((c) => {
    if (c.contexts[name]) {
      throw new CliError(
        `Context '${name}' already exists.\n` +
          `Replace its accounts with: csw context set ${name} <accounts...>\n` +
          `Or append one with: csw account add <adapter> --name <n> --context ${name}`
      );
    }
    c.contexts[name] = {
      ...(opts.description ? { description: opts.description as string } : {}),
      accounts: accountIds
    };
  });

  console.log(`Context added: ${name} [${accountIds.join(", ")}]`);
  const denied = deniedAdapters(config, name);
  if (denied.length > 0) console.log(`Denied in this context: ${denied.join(", ")} (add accounts to enable)`);
  if (!config.defaultContext) console.log(`Tip: csw use ${name}   # make it the global default`);
}

function contextSet(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--description": "description", "-d": "description" }
  });
  if (pos.length < 2) {
    throw new CliError("Usage: csw context set <name> <adapter>:<account> [...more] [--description <text>]");
  }
  const [name, ...accountIds] = pos;

  mutateConfig((c) => {
    const existing = c.contexts[name];
    if (!existing) {
      const known = Object.keys(c.contexts).sort().join(", ") || "(none)";
      throw new CliError(`Unknown context: ${name}\nKnown contexts: ${known}\nCreate it with: csw context add`);
    }
    existing.accounts = accountIds;
    if (opts.description) existing.description = opts.description as string;
  });
  console.log(`Context updated: ${name} [${accountIds.join(", ")}]`);
}

function contextRemove(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw context remove <name>");
  const name = pos[0];

  const messages: string[] = [];
  mutateConfig((config) => {
    if (!config.contexts[name]) throw new CliError(`Unknown context: ${name}`);
    delete config.contexts[name];
    for (const [dir, ctx] of Object.entries(config.bindings)) {
      if (ctx === name) {
        delete config.bindings[dir];
        messages.push(`Removed binding: ${redactHome(dir)}`);
      }
    }
    if (config.defaultContext === name) {
      delete config.defaultContext;
      messages.push("Cleared global default context.");
    }
  });
  for (const message of messages) console.log(message);
  console.log(`Context removed: ${name} (accounts and credential state untouched)`);
}

// ---------------------------------------------------------------------------
// list / use / bind / unbind

export function cmdList(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length > 0) throw new CliError("Usage: csw list");
  const config = loadConfig();
  const names = Object.keys(config.contexts).sort();

  if (names.length === 0) {
    console.log("No contexts configured. Start with: csw init && csw account add <adapter> --name <name>");
    return;
  }

  console.log("Contexts:");
  for (const name of names) {
    const context = config.contexts[name];
    const marker = name === config.defaultContext ? "*" : " ";
    const description = context.description ? `  ${context.description}` : "";
    console.log(`${marker} ${name} [${context.accounts.join(", ")}]${description}`);
    for (const [dir, ctx] of Object.entries(config.bindings).sort()) {
      if (ctx === name) console.log(`     bound: ${redactHome(dir)}`);
    }
  }

  const accountIds = Object.keys(config.accounts).sort();
  if (accountIds.length > 0) {
    console.log("Accounts:");
    for (const id of accountIds) {
      console.log(`  ${id}  ${describeAccount(config.accounts[id])}`);
    }
  }
  if (config.defaultContext) console.log(`Default: ${config.defaultContext} (marked *)`);
}

export function cmdUse(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw use <context>");
  mutateConfig((config) => {
    if (!config.contexts[pos[0]]) {
      const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
      throw new CliError(`Unknown context: ${pos[0]}\nKnown contexts: ${known}`);
    }
    config.defaultContext = pos[0];
  });
  console.log(`Global default context: ${pos[0]}`);
  console.log("Folder bindings and pinned shells still take precedence over the default.");
}

export function cmdBind(args: string[]): void {
  const { pos, opts } = parseArgs(args, { valueFlags: { "--dir": "dir" } });
  if (pos.length !== 1) throw new CliError("Usage: csw bind <context> [--dir <dir>]");
  const contextName = pos[0];
  const dir = realpathSafe(expandPath((opts.dir as string | undefined) ?? process.cwd()));
  if (/[\t\n]/.test(dir)) throw new CliError("Directory paths with tabs or newlines cannot be bound.");
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new CliError(`Not a directory: ${dir}`);
  }

  mutateConfig((config) => {
    if (!config.contexts[contextName]) {
      const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
      throw new CliError(`Unknown context: ${contextName}\nKnown contexts: ${known}`);
    }
    config.bindings[dir] = contextName;
  });
  console.log(`Bound ${redactHome(dir)} → ${contextName}`);
  console.log(`Auto-switch on cd needs the hook once in your shell rc: eval "$(csw hook zsh)"`);
  console.log(`Without the hook, 'csw run' and 'csw current' still resolve this binding.`);
}

export function cmdUnbind(args: string[]): void {
  const { pos, opts } = parseArgs(args, { valueFlags: { "--dir": "dir" } });
  if (pos.length !== 0) throw new CliError("Usage: csw unbind [--dir <dir>]");
  const dir = realpathSafe(expandPath((opts.dir as string | undefined) ?? process.cwd()));
  let was = "";
  mutateConfig((config) => {
    if (!config.bindings[dir]) throw new CliError(`No binding for ${dir}`);
    was = config.bindings[dir];
    delete config.bindings[dir];
  });
  console.log(`Unbound ${redactHome(dir)} (was → ${was})`);
}

// ---------------------------------------------------------------------------
// current / run / shell / env / hook

export function cmdCurrent(args: string[]): void {
  const { pos, opts } = parseArgs(args, { boolFlags: { "--explain": "explain" } });
  if (pos.length > 0) throw new CliError("Usage: csw current [--explain]");
  const config = loadConfig();
  const res = resolveContext(config, { env: process.env, cwd: process.cwd() });

  if (!opts.explain) {
    console.log(res.name ?? "(none)");
    return;
  }

  console.log(`Context: ${res.name ?? "(none)"}`);
  console.log(`Source:  ${describeSource(res)}`);
  if (!res.name) {
    console.log("Select one with: csw run --context <ctx> -- ... | csw bind <ctx> | csw use <ctx>");
    return;
  }

  const env = envForContext(config, res.name);
  const context = config.contexts[res.name];
  console.log("Accounts:");
  for (const id of context.accounts) {
    const account = config.accounts[id];
    if (account.system) {
      console.log(`  ${id}  (machine default)`);
      continue;
    }
    const pairs = Object.entries(getAdapter(account.adapter).envFor(account))
      .map(([k, v]) => `${k}=${v === null ? "(unset)" : redactHome(v)}`)
      .join(" ");
    console.log(`  ${id}  ${pairs}`);
  }
  const denied = deniedAdapters(config, res.name);
  if (denied.length > 0) {
    console.log(`Denied:  ${denied.join(", ")} (not in this context — their CLIs will report not-logged-in)`);
  }
  const cleared = Object.entries(env)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (cleared.length > 0) console.log(`Cleared: ${cleared.join(", ")}`);
}

export function cmdRun(args: string[]): void {
  const sep = args.indexOf("--");
  if (sep === -1) {
    throw new CliError(
      'Usage: csw run [--context <ctx>] -- <command> [args...]\nExample: csw run --context work -- az account show'
    );
  }
  const { pos, opts } = parseArgs(args.slice(0, sep), {
    valueFlags: { "--context": "context", "-c": "context" }
  });
  if (pos.length > 0) throw new CliError(`Unexpected argument before '--': ${pos[0]}`);
  const command = args.slice(sep + 1);
  if (command.length === 0) throw new CliError("Usage: csw run [--context <ctx>] -- <command> [args...]");

  const config = loadConfig();
  const res = resolveContext(config, {
    flag: opts.context as string | undefined,
    env: process.env,
    cwd: process.cwd()
  });
  if (!res.name) {
    throw new CliError(
      "No context resolved.\n" +
        "Use --context <ctx>, bind this folder (csw bind <ctx>), or set a default (csw use <ctx>)."
    );
  }

  const env = envForContext(config, res.name);
  const result = spawnSync(command[0], command.slice(1), {
    env: applyEnv(process.env, env),
    stdio: "inherit"
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new CliError(`Command not found: ${command[0]}`);
    throw new CliError(result.error.message);
  }
  if (result.signal) {
    const signals = os.constants.signals as Record<string, number>;
    process.exit(128 + (signals[result.signal] ?? 1));
  }
  process.exit(result.status ?? 1);
}

export function cmdShell(args: string[]): void {
  const { pos, opts } = parseArgs(args, { boolFlags: { "--off": "off" } });

  if (opts.off) {
    if (pos.length > 0) throw new CliError("Usage: csw shell --off");
    for (const line of shellLines(clearedEnv())) console.log(line);
    return;
  }

  if (pos.length > 1) throw new CliError("Usage: csw shell [<context>] | csw shell --off");
  const config = loadConfig();
  let name = pos[0];
  if (name) {
    if (!config.contexts[name]) {
      const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
      throw new CliError(`Unknown context: ${name}\nKnown contexts: ${known}`);
    }
  } else {
    const res = resolveContext(config, { env: process.env, cwd: process.cwd() });
    if (!res.name) throw new CliError("No context resolved. Pass one: csw shell <context>");
    name = res.name;
  }

  const env = envForContext(config, name);
  env.AGENTCTX_OVERRIDE = "1"; // pin: the hook will leave this shell alone
  env.AGENTCTX_BOUND_DIR = null;
  env.AGENTCTX_HOOK_KEY = null;
  for (const line of shellLines(env)) console.log(line);
}

/**
 * Plumbing for the shell hook: `csw env --cwd <dir>` resolves that location
 * through the real resolver (bindings, then default — never shell overrides)
 * and emits the environment; `csw env --clear` resets everything.
 */
export function cmdEnv(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--cwd": "cwd" },
    boolFlags: { "--clear": "clear" }
  });
  if (pos.length > 0) throw new CliError("Usage: csw env --cwd <dir> | csw env --clear");

  if (opts.clear) {
    for (const line of shellLines(clearedEnv())) console.log(line);
    return;
  }

  const cwdOpt = opts.cwd as string | undefined;
  if (!cwdOpt) throw new CliError("Usage: csw env --cwd <dir> | csw env --clear");

  const config = loadConfig();
  // Location-only resolution: an empty env excludes pins and inherited contexts.
  const res = resolveContext(config, { env: {}, cwd: cwdOpt });

  if (!res.name) {
    for (const line of shellLines(clearedEnv())) console.log(line);
    return;
  }

  const env = envForContext(config, res.name);
  env.AGENTCTX_BOUND_DIR = res.bindingDir ?? null;
  env.AGENTCTX_OVERRIDE = null;
  for (const line of shellLines(env)) console.log(line);
}

export function cmdHook(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw hook <zsh|bash>");
  const shell = pos[0];
  if (shell === "zsh") process.stdout.write(zshHook());
  else if (shell === "bash") process.stdout.write(bashHook());
  else throw new CliError("Usage: csw hook <zsh|bash>");
}

// ---------------------------------------------------------------------------
// doctor

export function cmdDoctor(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length > 1) throw new CliError("Usage: csw doctor [<context>]");
  const config = loadConfig();
  writeBindingsList(config); // heal a hand-edited config's hook list

  if (pos[0] && !config.contexts[pos[0]]) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context: ${pos[0]}\nKnown contexts: ${known}`);
  }
  const names = pos[0] ? [pos[0]] : Object.keys(config.contexts).sort();
  if (names.length === 0) {
    console.log("No contexts configured.");
    return;
  }

  console.log(`Config: ${redactHome(configPath())}`);
  console.log(`State:  ${redactHome(stateRoot())}`);

  let failed = false;
  for (const name of names) {
    console.log(`\n${name}${config.contexts[name].description ? ` — ${config.contexts[name].description}` : ""}`);
    for (const id of config.contexts[name].accounts) {
      const account = config.accounts[id];
      const adapter = getAdapter(account.adapter);

      for (const field of ["stateDir", "kubeconfig"] as const) {
        const value = account[field];
        if (!value) continue;
        if (fs.existsSync(value)) {
          console.log(`  ok ${id} ${field}: ${redactHome(value)}`);
        } else {
          failed = true;
          console.log(`  !  ${id} ${field}: missing ${redactHome(value)}`);
        }
      }

      if (!cliInstalled(adapter.cli)) {
        failed = true;
        console.log(`  !  ${id}: '${adapter.cli}' is not installed`);
        continue;
      }
      if (adapter.identity) {
        const identity = runIdentity(account);
        if (!identity.ok) {
          failed = true;
          console.log(`  !  ${id} identity: ${identity.summary}`);
        } else if (account.pin && identity.summary !== account.pin) {
          failed = true;
          console.log(`  !  ${id} identity drift:`);
          console.log(`       pinned: ${account.pin}`);
          console.log(`       actual: ${identity.summary}`);
          console.log(`       accept the new identity with: csw account pin ${id}`);
        } else {
          console.log(`  ok ${id} identity: ${identity.summary}${account.pin ? " (pinned)" : ""}`);
        }
      }
    }
    const denied = deniedAdapters(config, name);
    if (denied.length > 0) console.log(`  -- denied: ${denied.join(", ")} (not in this context)`);
  }

  if (failed) throw new CliError("\nDoctor found issues.", 2);
  console.log("\nAll checks passed.");
}
