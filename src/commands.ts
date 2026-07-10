import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { adapterNames, getAdapter, type AccountConfig } from "./adapters.js";
import {
  configExists,
  emptyConfig,
  loadConfig,
  saveConfig,
  writeBindingsList,
  type Config
} from "./config.js";
import { allManagedVars, applyEnv, clearedEnv, envForContext, shellLines, type EnvOverrides } from "./env.js";
import { bashHook, zshHook } from "./hooks.js";
import { cliInstalled, runIdentity } from "./identity.js";
import { configPath, stateRoot } from "./paths.js";
import { describeSource, resolveContext } from "./resolver.js";
import { CliError, ensureDir, expandPath, parseArgs, realpathSafe, redactHome } from "./util.js";

// ---------------------------------------------------------------------------
// init

export function cmdInit(args: string[]): void {
  parseArgs(args); // no flags, error on stray ones
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
    default:
      throw new CliError("Usage: csw account <add|list|remove> ...");
  }
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

  const id = `${adapter.name}:${name}`;
  const config = loadConfig();
  if (config.accounts[id]) {
    throw new CliError(`Account '${id}' already exists. Pick a different --name or remove it first.`);
  }

  const account: AccountConfig = { adapter: adapter.name };
  let freshLogin = false;

  if (adapter.name === "kubernetes") {
    const kubeconfig = opts.kubeconfig as string | undefined;
    if (!kubeconfig) {
      throw new CliError(
        "The kubernetes adapter references an existing kubeconfig file:\n" +
          "  csw account add kubernetes --name work --kubeconfig ~/.kube/work.yaml"
      );
    }
    const resolved = expandPath(kubeconfig);
    if (!fs.existsSync(resolved)) throw new CliError(`kubeconfig not found: ${resolved}`);
    account.kubeconfig = kubeconfig;
  } else if (opts.system) {
    if (!adapter.allowSystem) {
      throw new CliError(`Adapter '${adapter.name}' does not support --system accounts.`);
    }
    account.system = true;
  } else if (opts.path) {
    const resolved = expandPath(opts.path as string);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CliError(`--path must be an existing directory: ${resolved}`);
    }
    account.stateDir = opts.path as string;
  } else {
    if (!adapter.freshStateDir) {
      throw new CliError(`Adapter '${adapter.name}' cannot create fresh state; use --path or --kubeconfig.`);
    }
    const dir = adapter.freshStateDir(name);
    ensureDir(dir);
    account.stateDir = dir;
    freshLogin = !opts.noLogin;
  }

  config.accounts[id] = account;

  const contextName = opts.context as string | undefined;
  if (contextName) {
    if (!config.contexts[contextName]) config.contexts[contextName] = { accounts: [] };
    config.contexts[contextName].accounts.push(id);
  }

  saveConfig(config); // validates (including one-adapter-per-context)

  if (account.system) {
    console.log(`Account added: ${id} (system default login — no isolated state)`);
  } else if (account.kubeconfig) {
    console.log(`Account added: ${id} (kubeconfig: ${redactHome(expandPath(account.kubeconfig))})`);
  } else if (opts.path) {
    console.log(`Account added: ${id} (references existing state at ${redactHome(expandPath(account.stateDir!))} — nothing was copied)`);
  } else {
    console.log(`Account added: ${id} (fresh state at ${redactHome(expandPath(account.stateDir!))})`);
  }

  if (freshLogin && adapter.loginCommand) {
    const argv = adapter.loginCommand(account);
    if (!cliInstalled(argv[0])) {
      console.log(`! ${argv[0]} is not installed — skipping login. Run later with:`);
      console.log(`    csw run --context <ctx> -- ${argv.join(" ")}`);
    } else {
      console.log(`Launching login: ${argv.join(" ")}`);
      const overrides: EnvOverrides = {};
      for (const v of allManagedVars()) overrides[v] = null;
      Object.assign(overrides, getAdapter(account.adapter).envFor(account));
      const result = spawnSync(argv[0], argv.slice(1), {
        env: applyEnv(process.env, overrides),
        stdio: "inherit"
      });
      if (result.status !== 0) {
        console.log(`! Login exited with status ${result.status ?? "unknown"}. The account entry was kept; retry the login any time.`);
      }
    }
  }

  if (adapter.identity) {
    const identity = runIdentity(account);
    console.log(identity.ok ? `  ok identity: ${identity.summary}` : `  !  identity: ${identity.summary}`);
  }

  if (contextName) {
    console.log(`Attached to context '${contextName}'.`);
  } else {
    console.log(`Next: csw context add <context> ${id}`);
  }
}

function accountList(args: string[]): void {
  parseArgs(args);
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
  if (account.system) parts.push("system default login");
  if (account.stateDir) parts.push(`state ${redactHome(expandPath(account.stateDir))}`);
  if (account.kubeconfig) parts.push(`kubeconfig ${redactHome(expandPath(account.kubeconfig))}`);
  if (account.description) parts.push(account.description);
  return parts.join(" — ");
}

function accountRemove(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw account remove <adapter>:<name>");
  const id = pos[0];
  const config = loadConfig();
  if (!config.accounts[id]) throw new CliError(`Unknown account: ${id}`);

  const usedBy = Object.entries(config.contexts)
    .filter(([, ctx]) => ctx.accounts.includes(id))
    .map(([name]) => name);
  if (usedBy.length > 0) {
    throw new CliError(
      `Account '${id}' is used by context(s): ${usedBy.join(", ")}.\n` +
        `Remove it from those contexts first (csw context remove, or edit ${redactHome(configPath())}).`
    );
  }

  const account = config.accounts[id];
  delete config.accounts[id];
  saveConfig(config);
  console.log(`Account removed from config: ${id}`);
  if (account.stateDir) {
    console.log(`Credential state was NOT deleted: ${redactHome(expandPath(account.stateDir))}`);
    console.log("Delete that directory yourself if you want the credentials gone.");
  }
}

// ---------------------------------------------------------------------------
// context

export function cmdContext(args: string[]): void {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return contextAdd(rest);
    case "remove":
      return contextRemove(rest);
    default:
      throw new CliError("Usage: csw context <add|remove> ...");
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
  const config = loadConfig();
  if (config.contexts[name]) {
    throw new CliError(
      `Context '${name}' already exists.\n` +
        `Append an account with: csw account add <adapter> --name <n> --context ${name}\n` +
        `Or remove it first: csw context remove ${name}`
    );
  }
  config.contexts[name] = {
    ...(opts.description ? { description: opts.description as string } : {}),
    accounts: accountIds
  };
  saveConfig(config); // validates account ids + adapter uniqueness
  console.log(`Context added: ${name} [${accountIds.join(", ")}]`);
  if (!config.defaultContext) {
    console.log(`Tip: csw use ${name}   # make it the global default`);
  }
}

function contextRemove(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw context remove <name>");
  const name = pos[0];
  const config = loadConfig();
  if (!config.contexts[name]) throw new CliError(`Unknown context: ${name}`);

  delete config.contexts[name];
  for (const [dir, ctx] of Object.entries(config.bindings)) {
    if (ctx === name) {
      delete config.bindings[dir];
      console.log(`Removed binding: ${redactHome(dir)}`);
    }
  }
  if (config.defaultContext === name) {
    delete config.defaultContext;
    console.log("Cleared global default context.");
  }
  saveConfig(config);
  console.log(`Context removed: ${name} (accounts and credential state untouched)`);
}

// ---------------------------------------------------------------------------
// list / use / bind / unbind

export function cmdList(args: string[]): void {
  parseArgs(args);
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
  const config = loadConfig();
  if (!config.contexts[pos[0]]) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context: ${pos[0]}\nKnown contexts: ${known}`);
  }
  config.defaultContext = pos[0];
  saveConfig(config);
  console.log(`Global default context: ${pos[0]}`);
  console.log("Folder bindings and pinned shells still take precedence over the default.");
}

export function cmdBind(args: string[]): void {
  const { pos, opts } = parseArgs(args, { valueFlags: { "--dir": "dir" } });
  if (pos.length !== 1) throw new CliError("Usage: csw bind <context> [--dir <dir>]");
  const contextName = pos[0];
  const dir = realpathSafe(expandPath((opts.dir as string | undefined) ?? process.cwd()));

  const config = loadConfig();
  if (!config.contexts[contextName]) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context: ${contextName}\nKnown contexts: ${known}`);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new CliError(`Not a directory: ${dir}`);
  }

  config.bindings[dir] = contextName;
  saveConfig(config);
  console.log(`Bound ${redactHome(dir)} → ${contextName}`);
  console.log(`Auto-switch on cd needs the hook once in your shell rc: eval "$(csw hook zsh)"`);
  console.log(`Without the hook, 'csw run' and 'csw current' still resolve this binding.`);
}

export function cmdUnbind(args: string[]): void {
  const { pos, opts } = parseArgs(args, { valueFlags: { "--dir": "dir" } });
  if (pos.length !== 0) throw new CliError("Usage: csw unbind [--dir <dir>]");
  const dir = realpathSafe(expandPath((opts.dir as string | undefined) ?? process.cwd()));
  const config = loadConfig();
  if (!config.bindings[dir]) throw new CliError(`No binding for ${dir}`);
  const was = config.bindings[dir];
  delete config.bindings[dir];
  saveConfig(config);
  console.log(`Unbound ${redactHome(dir)} (was → ${was})`);
}

// ---------------------------------------------------------------------------
// current / run / shell / env / hook

export function cmdCurrent(args: string[]): void {
  const { opts } = parseArgs(args, { boolFlags: { "--explain": "explain" } });
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
    const pairs = Object.entries(getAdapter(account.adapter).envFor(account))
      .map(([k, v]) => `${k}=${v === null ? "(unset)" : redactHome(v)}`)
      .join(" ");
    console.log(`  ${id}  ${pairs || "(system default)"}`);
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
  process.exit(result.status ?? (result.signal ? 130 : 1));
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
  for (const line of shellLines(env)) console.log(line);
}

/** Plumbing for the shell hook. `csw env --dir <boundDir>` or `csw env --clear`. */
export function cmdEnv(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--dir": "dir" },
    boolFlags: { "--clear": "clear" }
  });
  if (pos.length > 0) throw new CliError("Usage: csw env --dir <dir> | csw env --clear");

  if (opts.clear) {
    for (const line of shellLines(clearedEnv())) console.log(line);
    return;
  }

  const dirOpt = opts.dir as string | undefined;
  if (!dirOpt) throw new CliError("Usage: csw env --dir <dir> | csw env --clear");
  const dir = realpathSafe(expandPath(dirOpt));

  const config = loadConfig();
  const contextName = config.bindings[dir];
  if (!contextName || !config.contexts[contextName]) {
    throw new CliError(`No binding for ${dir}`);
  }

  const env = envForContext(config, contextName);
  env.AGENTCTX_BOUND_DIR = dir;
  env.AGENTCTX_OVERRIDE = null;
  for (const line of shellLines(env)) console.log(line);
}

export function cmdHook(args: string[]): void {
  const { pos } = parseArgs(args);
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

  const names = pos[0] ? [pos[0]] : Object.keys(config.contexts).sort();
  if (pos[0] && !config.contexts[pos[0]]) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context: ${pos[0]}\nKnown contexts: ${known}`);
  }
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
        const resolved = expandPath(value);
        if (fs.existsSync(resolved)) {
          console.log(`  ok ${id} ${field}: ${redactHome(resolved)}`);
        } else {
          failed = true;
          console.log(`  !  ${id} ${field}: missing ${redactHome(resolved)}`);
        }
      }

      if (!cliInstalled(adapter.cli)) {
        failed = true;
        console.log(`  !  ${id}: '${adapter.cli}' is not installed`);
        continue;
      }
      if (adapter.identity) {
        const identity = runIdentity(account);
        if (identity.ok) console.log(`  ok ${id} identity: ${identity.summary}`);
        else {
          failed = true;
          console.log(`  !  ${id} identity: ${identity.summary}`);
        }
      }
    }
  }

  if (failed) throw new CliError("\nDoctor found issues.", 2);
  console.log("\nAll checks passed.");
}
