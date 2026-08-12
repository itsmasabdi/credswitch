import fs from "node:fs";
import { adapterNames } from "../adapters.js";
import { loadConfig, mutateConfig } from "../config.js";
import { deniedAdapters } from "../env.js";
import { resolveContext } from "../resolver.js";
import { CliError, expandPath, parseArgs, realpathSafe, redactHome } from "../util.js";
import { ensureConfig, forbidBroadDir, hintHookIfMissing, unknownContext } from "./shared.js";

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
    if (!config.contexts[contextName]) throw unknownContext(config, contextName);
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

/** Porcelain: bind this folder to a named context, creating it if needed. */
export function cmdLocal(args: string[]): void {
  const { pos } = parseArgs(args);
  ensureConfig();
  const dir = realpathSafe(process.cwd());

  if (pos.length === 0) {
    const config = loadConfig();
    const res = resolveContext(config, { env: {}, cwd: dir });
    if (res.source === "binding") {
      console.log(`${res.name}  (bound at ${redactHome(res.bindingDir!)})`);
    } else if (res.source === "default") {
      console.log(`(no binding here — global default '${res.name}' applies)`);
    } else {
      console.log("(no binding here, no global default — run: csw login <adapter>)");
    }
    return;
  }

  if (pos.length !== 1) throw new CliError("Usage: csw local [<context>]");
  forbidBroadDir(dir);
  const name = pos[0];

  let created = false;
  const config = mutateConfig((c) => {
    if (!c.contexts[name]) {
      c.contexts[name] = { accounts: [] };
      created = true;
    }
    c.bindings[dir] = name;
  });

  console.log(`${redactHome(dir)} → ${name}${created ? " (new context)" : ""}`);
  const accounts = config.contexts[name].accounts;
  if (accounts.length === 0) {
    console.log(`Now give it identities: csw login <adapter>   (${adapterNames().join(", ")})`);
  } else {
    console.log(`Accounts: ${accounts.join(", ")}`);
    const denied = deniedAdapters(config, name);
    if (denied.length > 0) console.log(`Denied: ${denied.join(", ")}`);
  }
  hintHookIfMissing();
}
