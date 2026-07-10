import os from "node:os";
import path from "node:path";
import { expandPath } from "./util.js";

export function configPath(): string {
  if (process.env.CREDSWITCH_CONFIG) return expandPath(process.env.CREDSWITCH_CONFIG);
  const configHome = process.env.XDG_CONFIG_HOME
    ? expandPath(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "credswitch", "config.json");
}

export function stateRoot(): string {
  if (process.env.CREDSWITCH_STATE_HOME) return expandPath(process.env.CREDSWITCH_STATE_HOME);
  const stateHome = process.env.XDG_STATE_HOME
    ? expandPath(process.env.XDG_STATE_HOME)
    : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "credswitch");
}

/** Plain-text list of bound directories, used by the shell hook's fast path. */
export function bindingsListPath(): string {
  return path.join(path.dirname(configPath()), "bindings.list");
}

/**
 * Read-only directory that denied providers are pointed into. Because it is
 * unwritable, no CLI can ever persist credentials there — an accidental
 * `az login` inside a denied context fails instead of silently creating a
 * shared fallback identity.
 */
export function deniedRoot(): string {
  return path.join(stateRoot(), "denied");
}
