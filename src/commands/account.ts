import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { adapterNames, getAdapter, type AccountConfig } from "../adapters.js";
import { repairCodexAccountMarketplace } from "../codex-state.js";
import { loadConfig, mutateConfig } from "../config.js";
import { applyEnv } from "../env.js";
import { cliInstalled, runIdentity } from "../identity.js";
import { ACCOUNT_NAME_RE, CliError, ensureDir, expandPath, parseArgs, realpathSafe, redactHome } from "../util.js";
import { describeAccount, emitJson, loginEnvFor } from "./shared.js";

export async function cmdAccount(args: string[]): Promise<void> {
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

async function accountAdd(args: string[]): Promise<void> {
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

  adapter.prepareStateDir?.(account);

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

  repairCodexAccountMarketplace(account);
  if (adapter.identity && cliInstalled(adapter.cli)) {
    const identity = await runIdentity(account);
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
  const { pos, opts } = parseArgs(args, { boolFlags: { "--json": "json" } });
  if (pos.length > 0) throw new CliError("Usage: csw account list [--json]");
  const config = loadConfig();
  const ids = Object.keys(config.accounts).sort();

  if (opts.json) {
    emitJson(ids.map((id) => ({ id, ...config.accounts[id] })));
    return;
  }

  if (ids.length === 0) {
    console.log("No accounts. Add one with: csw account add <adapter> --name <name>");
    return;
  }
  for (const id of ids) console.log(`  ${id}  ${describeAccount(config.accounts[id])}`);
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

async function accountPin(args: string[]): Promise<void> {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw account pin <adapter>:<name>");
  const id = pos[0];
  const config = loadConfig();
  const account = config.accounts[id];
  if (!account) throw new CliError(`Unknown account: ${id}`);

  const identity = await runIdentity(account);
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

async function accountLogin(args: string[]): Promise<void> {
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
  adapter.prepareStateDir?.(account);
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

  repairCodexAccountMarketplace(account);
  const identity = await runIdentity(account);
  if (identity.ok) {
    mutateConfig((c) => {
      if (c.accounts[id]) c.accounts[id].pin = identity.summary;
    });
    console.log(`  ok identity: ${identity.summary} (pinned)`);
  } else {
    console.log(`  !  identity: ${identity.summary}`);
  }
}
