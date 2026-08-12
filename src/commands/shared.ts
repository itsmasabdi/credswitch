import os from "node:os";
import path from "node:path";
import { getAdapter, type AccountConfig } from "../adapters.js";
import { repairCodexAccountMarketplace } from "../codex-state.js";
import { configExists, emptyConfig, saveConfig, type Config } from "../config.js";
import { allManagedVars, type EnvOverrides } from "../env.js";
import { CliError, realpathSafe, redactHome } from "../util.js";

/** Print a value as the command's machine-readable result. */
export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function ensureConfig(): void {
  if (!configExists()) saveConfig(emptyConfig());
}

/**
 * The environment a provider's own login runs under: everything managed is
 * cleared, then this account's selectors applied.
 */
export function loginEnvFor(account: AccountConfig): EnvOverrides {
  repairCodexAccountMarketplace(account);
  const overrides: EnvOverrides = {};
  for (const name of allManagedVars()) overrides[name] = null;
  if (!account.system) Object.assign(overrides, getAdapter(account.adapter).envFor(account));
  return overrides;
}

export function describeAccount(account: AccountConfig): string {
  const parts: string[] = [];
  if (account.system) parts.push("machine default");
  if (account.stateDir) parts.push(`state ${redactHome(account.stateDir)}`);
  if (account.kubeconfig) parts.push(`kubeconfig ${redactHome(account.kubeconfig)}`);
  if (account.pin) parts.push(`pinned: ${account.pin}`);
  return parts.join(" — ");
}

export function forbidBroadDir(dir: string): void {
  if (dir === "/" || dir === realpathSafe(os.homedir())) {
    throw new CliError(
      `Refusing to bind ${dir === "/" ? "the filesystem root" : "your home directory"} — ` +
        `that would apply one identity to everything.\n` +
        `cd into a project folder, or use --global for your machine-wide default.`
    );
  }
  if (/[\t\n]/.test(dir)) throw new CliError("Directory paths with tabs or newlines cannot be bound.");
}

export function contextNameForDir(config: Config, dir: string): string {
  const base = path.basename(dir).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "project";
  let name = base;
  let n = 2;
  while (config.contexts[name]) name = `${base}-${n++}`;
  return name;
}

export function hookActiveHere(): boolean {
  return Boolean(process.env.CREDSWITCH_HOOK_KEY || process.env.CREDSWITCH_OVERRIDE);
}

export function hintHookIfMissing(): void {
  if (!hookActiveHere()) {
    console.log("Automatic switching isn't active in this shell yet — run 'csw setup' once, then restart the shell.");
  }
}

export function unknownContext(config: Config, name: string): CliError {
  const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
  return new CliError(`Unknown context: ${name}\nKnown contexts: ${known}`);
}
