import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterNames, getAdapter } from "../adapters.js";
import { repairCodexAccountMarketplace } from "../codex-state.js";
import { configExists, emptyConfig, loadConfig, mutateConfig, saveConfig } from "../config.js";
import { applyEnv } from "../env.js";
import { shellBootstrap } from "../hooks.js";
import { cliInstalled, runIdentity } from "../identity.js";
import { configPath } from "../paths.js";
import { resolveContext } from "../resolver.js";
import { ACCOUNT_NAME_RE, CliError, ensureDir, parseArgs, realpathSafe, redactHome } from "../util.js";
import {
  contextNameForDir,
  ensureConfig,
  forbidBroadDir,
  hintHookIfMissing,
  hookActiveHere,
  loginEnvFor
} from "./shared.js";

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

/**
 * The everyday interface. A folder gets an identity the moment you log in
 * inside it — context creation, naming, and binding are inferred. The
 * account/context/bind commands remain as plumbing underneath.
 */
export async function cmdLogin(args: string[]): Promise<void> {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--as": "as" },
    boolFlags: { "--global": "global" }
  });
  if (pos.length !== 1) {
    throw new CliError(
      `Usage: csw login <adapter> [--as <name>] [--global]\nAdapters: ${adapterNames().join(", ")}`
    );
  }
  const adapter = getAdapter(pos[0]);
  if (adapter.name === "kubernetes") {
    throw new CliError(
      "kubernetes has no login flow — reference a kubeconfig instead:\n" +
        "  csw account add kubernetes --name <n> --kubeconfig <file> --context <ctx>"
    );
  }

  ensureConfig();
  const dir = realpathSafe(process.cwd());
  const config = loadConfig();

  // 1. DECIDE the target context — nothing is written until step 5, so a
  //    cancelled login truly saves nothing. A folder only ever gains an
  //    identity through this explicit act of logging in inside it — never
  //    through anything a repo ships.
  let contextName: string;
  let bindDir: string | undefined;
  let setDefault = false;
  let seedAccounts: string[] = [];
  let inheritedFrom: string | undefined;

  if (opts.global) {
    contextName = config.defaultContext ?? "global";
    setDefault = !config.defaultContext;
  } else {
    const res = resolveContext(config, { env: {}, cwd: dir });
    if (res.source === "binding" && res.bindingDir === dir) {
      // Only an EXACT binding means "this folder's context". An ancestor's
      // binding is shared with sibling folders — mutating it here could
      // change their credentials, so we create a local override instead.
      contextName = res.name!;
    } else {
      forbidBroadDir(dir);
      contextName = contextNameForDir(config, dir);
      bindDir = dir;
      if (res.name && config.contexts[res.name]) {
        // Seed the new context with everything that already applies here, so
        // the override only changes this one adapter — no surprise denials.
        seedAccounts = [...config.contexts[res.name].accounts];
        inheritedFrom =
          res.source === "binding"
            ? `${res.name} (bound at ${redactHome(res.bindingDir!)})`
            : `${res.name} (global default)`;
      }
    }
  }

  // 2. Account: reuse if it exists, otherwise fresh isolated state.
  const accountName = (opts.as as string | undefined) ?? contextName;
  if (!ACCOUNT_NAME_RE.test(accountName)) {
    throw new CliError(`Invalid account name '${accountName}'. Use letters, digits, dots, dashes, underscores.`);
  }
  const id = `${adapter.name}:${accountName}`;
  let account = config.accounts[id];
  let createdFreshDir: string | undefined;

  if (account) {
    console.log(`Using existing account ${id}${account.system ? " (machine default)" : ""}.`);
  } else {
    if (!adapter.freshStateDir) {
      throw new CliError(`Adapter '${adapter.name}' cannot create fresh state; use csw account add with --path.`);
    }
    const stateDir = adapter.freshStateDir(accountName);
    if (fs.existsSync(stateDir) && fs.readdirSync(stateDir).length > 0) {
      throw new CliError(
        `${redactHome(stateDir)} already exists and is not empty.\n` +
          `Reference it instead: csw account add ${adapter.name} --name ${accountName} --path ${stateDir}`
      );
    }
    ensureDir(stateDir);
    createdFreshDir = stateDir;
    account = { adapter: adapter.name, stateDir };
  }

  repairCodexAccountMarketplace(account);
  adapter.prepareStateDir?.(account);

  // 3. Log in when needed: always for fresh state; for an existing account
  //    only when its identity check fails. `csw account login` forces re-auth.
  let needLogin = Boolean(createdFreshDir);
  if (!needLogin && !account.system && adapter.identity && cliInstalled(adapter.cli)) {
    const identity = await runIdentity(account);
    if (!identity.ok) needLogin = true;
  }

  if (needLogin) {
    if (!adapter.loginCommand) throw new CliError(`Adapter '${adapter.name}' has no login command.`);
    const argv = adapter.loginCommand(account);
    if (!cliInstalled(argv[0])) {
      if (createdFreshDir) fs.rmSync(createdFreshDir, { recursive: true, force: true });
      throw new CliError(`${argv[0]} is not installed (or not on PATH).`);
    }
    console.log(`Launching login: ${argv.join(" ")}`);
    const result = spawnSync(argv[0], argv.slice(1), {
      env: applyEnv(process.env, loginEnvFor(account)),
      stdio: "inherit"
    });
    if (result.status !== 0) {
      if (createdFreshDir) fs.rmSync(createdFreshDir, { recursive: true, force: true });
      throw new CliError(`Login failed or was cancelled (exit ${result.status ?? "unknown"}). Nothing was saved.`);
    }
    repairCodexAccountMarketplace(account);
  }

  // 4. Pin the identity; warn if it duplicates another account of this adapter
  //    (the "logged into the wrong account" accident).
  if (adapter.identity && cliInstalled(adapter.cli)) {
    const identity = await runIdentity(account);
    if (identity.ok) {
      account.pin = identity.summary;
      console.log(`  ok identity: ${identity.summary} (pinned)`);
      for (const [otherId, other] of Object.entries(config.accounts)) {
        if (otherId !== id && other.adapter === adapter.name && other.pin === identity.summary) {
          console.log(`  !! same identity as ${otherId} — did you log into the account you meant?`);
        }
      }
    } else {
      console.log(`  !  identity: ${identity.summary}`);
    }
  }

  // 5. Single atomic commit: context, default, binding, account, slot swap.
  //    Everything before this point only touched isolated state dirs.
  let replaced: string | undefined;
  mutateConfig((c) => {
    if (!c.contexts[contextName]) {
      c.contexts[contextName] = { accounts: seedAccounts.filter((seeded) => c.accounts[seeded]) };
    }
    if (setDefault && !c.defaultContext) c.defaultContext = contextName;
    if (bindDir) c.bindings[bindDir] = contextName;
    c.accounts[id] = account!;
    const ctx = c.contexts[contextName];
    const slot = ctx.accounts.findIndex((a) => a !== id && c.accounts[a]?.adapter === adapter.name);
    if (slot >= 0) {
      replaced = ctx.accounts[slot];
      ctx.accounts[slot] = id;
    } else if (!ctx.accounts.includes(id)) {
      ctx.accounts.push(id);
    }
  });

  if (setDefault) console.log(`Created global default context '${contextName}'.`);
  if (bindDir) {
    console.log(
      `${redactHome(bindDir)} → ${contextName} (new context${inheritedFrom ? `, inheriting from ${inheritedFrom}` : ""}, bound to this folder)`
    );
  }
  console.log(`Context '${contextName}': ${adapter.name} → ${id}${replaced ? ` (replaced ${replaced})` : ""}`);
  if (hookActiveHere()) console.log("Active from your next prompt.");
  else {
    hintHookIfMissing();
    console.log(`Until then: csw run -- ${adapter.cli} ...`);
  }
}

export function cmdSetup(args: string[]): void {
  const { pos, opts } = parseArgs(args, { valueFlags: { "--shell": "shell" } });
  if (pos.length > 0) throw new CliError("Usage: csw setup [--shell zsh|bash]");

  ensureConfig();
  console.log(`Config: ${redactHome(configPath())}`);

  const config = loadConfig();
  for (const [id, account] of Object.entries(config.accounts)) {
    const marketplace = repairCodexAccountMarketplace(account);
    if (marketplace?.kind === "repaired") {
      console.log(
        `Repaired ${id} bundled marketplace: ${redactHome(marketplace.previousSource)} → ${redactHome(marketplace.expectedSource)}`
      );
    } else if (marketplace?.kind === "failed") {
      console.log(`! ${id} bundled marketplace: ${marketplace.reason}`);
    }
  }

  const shell = (opts.shell as string | undefined) ?? (process.env.SHELL?.endsWith("bash") ? "bash" : "zsh");
  if (shell !== "zsh" && shell !== "bash") throw new CliError("Supported shells: zsh, bash");
  const rcFile = path.join(os.homedir(), shell === "zsh" ? ".zshrc" : ".bashrc");
  const existing = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf8") : "";

  if (existing.includes("csw hook")) {
    console.log(`Hook already installed in ${redactHome(rcFile)}.`);
  } else {
    fs.appendFileSync(rcFile, `\n${shellBootstrap(shell)}`);
    console.log(`Installed hook in ${redactHome(rcFile)}.`);
    console.log(`Restart your shell (or run: exec ${shell}) to activate.`);
  }

  console.log(`
Then, in any project folder:
  csw login claude        # give THIS folder its own Claude account (or azure, gcloud, github, codex)
  claude                  # uses that folder's identity — and only there`);
}
