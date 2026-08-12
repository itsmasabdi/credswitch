import { spawnSync } from "node:child_process";
import os from "node:os";
import { getAdapter } from "../adapters.js";
import { configExists, loadConfig } from "../config.js";
import { applyEnv, clearedEnv, deniedAdapters, envForContext, shellLines } from "../env.js";
import { bashHook, zshHook } from "../hooks.js";
import { describeSource, resolveContext } from "../resolver.js";
import { CliError, parseArgs, redactHome } from "../util.js";
import { emitJson, unknownContext } from "./shared.js";

export function cmdCurrent(args: string[]): void {
  const { pos, opts } = parseArgs(args, { boolFlags: { "--explain": "explain", "--json": "json" } });
  if (pos.length > 0) throw new CliError("Usage: csw current [--explain] [--json]");
  const config = loadConfig();
  const res = resolveContext(config, { env: process.env, cwd: process.cwd() });

  if (opts.json) {
    const env = res.name ? envForContext(config, res.name) : {};
    emitJson({
      context: res.name,
      source: res.source,
      sourceDetail: describeSource(res),
      bindingDir: res.bindingDir ?? null,
      accounts: (res.name ? config.contexts[res.name].accounts : []).map((id) => {
        const account = config.accounts[id];
        return {
          id,
          adapter: account.adapter,
          system: Boolean(account.system),
          pin: account.pin ?? null,
          env: account.system ? {} : getAdapter(account.adapter).envFor(account)
        };
      }),
      denied: res.name ? deniedAdapters(config, res.name) : [],
      cleared: Object.entries(env)
        .filter(([, value]) => value === null)
        .map(([key]) => key)
    });
    return;
  }

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
  console.log("Accounts:");
  for (const id of config.contexts[res.name].accounts) {
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
  // The floor for everything this command spawns. CREDSWITCH_CONTEXT alone is
  // not enough: a hooked subshell (an agent's Bash tool sources the user's rc)
  // re-resolves from cwd and would silently drop back to the global default.
  // A separate marker lets the hook tell "an ancestor process chose this" from
  // "I applied this last prompt", so folder bindings still win but the run
  // context beats the default — the documented precedence.
  env.CREDSWITCH_INHERIT = res.name;
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
    if (!config.contexts[name]) throw unknownContext(config, name);
  } else {
    const res = resolveContext(config, { env: process.env, cwd: process.cwd() });
    if (!res.name) throw new CliError("No context resolved. Pass one: csw shell <context>");
    name = res.name;
  }

  const env = envForContext(config, name);
  env.CREDSWITCH_OVERRIDE = "1"; // pin: the hook will leave this shell alone
  env.CREDSWITCH_BOUND_DIR = null;
  env.CREDSWITCH_HOOK_KEY = null;
  for (const line of shellLines(env)) console.log(line);
}

/**
 * Plumbing for the shell hook: `csw env --cwd <dir>` resolves that location
 * through the real resolver (bindings, then the floor an ancestor `csw run`
 * set — never this shell's own pin) and emits the environment; `csw env
 * --clear` resets everything.
 */
export function cmdEnv(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--cwd": "cwd", "--inherit": "inherit" },
    boolFlags: { "--clear": "clear" }
  });
  if (pos.length > 0) throw new CliError("Usage: csw env --cwd <dir> [--inherit <ctx>] | csw env --clear");

  if (opts.clear) {
    for (const line of shellLines(clearedEnv())) console.log(line);
    return;
  }

  const cwdOpt = opts.cwd as string | undefined;
  if (!cwdOpt) throw new CliError("Usage: csw env --cwd <dir> [--inherit <ctx>] | csw env --clear");

  // The context floor set by an ancestor `csw run`, forwarded by the hook.
  const inherit = (opts.inherit as string | undefined) ?? "";

  // No config at all isn't a failure for the hook — it's "nothing configured".
  if (!configExists()) {
    const env = clearedEnv();
    env.CREDSWITCH_HOOK_KEY = `|d:${inherit}`; // matches the hook's key when no list is readable
    for (const line of shellLines(env)) console.log(line);
    return;
  }

  const config = loadConfig();
  // Location first, then the inherited floor — never this shell's own pin or
  // last-applied context, which would make a bound tree impossible to leave.
  // A stale --inherit is ignored rather than fatal: the hook reads any failure
  // as "deny everything", which is far worse than falling back to the default.
  const res = resolveContext(config, {
    env: inherit && config.contexts[inherit] ? { CREDSWITCH_CONTEXT: inherit } : {},
    cwd: cwdOpt
  });

  // The key carries the gen of the config we ACTUALLY read. If the bindings
  // list was momentarily ahead (list is written first), the stamped key won't
  // match the hook's computed key, so the hook simply asks again next prompt.
  // It is a function of the hook's INPUTS (gen, binding, inherit), never of
  // what resolved — otherwise the two can never agree.
  const gen = config.gen;

  if (!res.name) {
    const env = clearedEnv();
    env.CREDSWITCH_HOOK_KEY = `${gen}|d:${inherit}`;
    for (const line of shellLines(env)) console.log(line);
    return;
  }

  const env = envForContext(config, res.name);
  env.CREDSWITCH_BOUND_DIR = res.bindingDir ?? null;
  env.CREDSWITCH_OVERRIDE = null;
  env.CREDSWITCH_HOOK_KEY =
    res.source === "binding" ? `${gen}|b:${res.bindingDir}:${res.name}` : `${gen}|d:${inherit}`;
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
