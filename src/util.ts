import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function expandPath(value: string): string {
  let expanded = value;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  expanded = expanded.replace(/\$HOME\b/g, os.homedir());
  return path.resolve(expanded);
}

/** Canonicalize to a real path so symlinked prefixes (e.g. /var -> /private/var) always match. */
export function realpathSafe(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export function redactHome(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function ensureDir(dir: string, mode = 0o700): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

export function atomicWrite(file: string, content: string, mode = 0o600): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

export interface ParsedArgs {
  pos: string[];
  opts: Record<string, string | boolean>;
}

/**
 * Tiny flag parser. `valueFlags` and `boolFlags` map every accepted spelling
 * (including aliases like -c) to a canonical option name.
 */
export function parseArgs(
  argv: string[],
  spec: { valueFlags?: Record<string, string>; boolFlags?: Record<string, string> } = {}
): ParsedArgs {
  const valueFlags = spec.valueFlags ?? {};
  const boolFlags = spec.boolFlags ?? {};
  const pos: string[] = [];
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-") || arg === "-") {
      pos.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag in boolFlags) {
      if (eq !== -1) throw new CliError(`Flag ${flag} does not take a value.`);
      opts[boolFlags[flag]] = true;
      continue;
    }
    if (flag in valueFlags) {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new CliError(`Flag ${flag} requires a value.`);
      opts[valueFlags[flag]] = value;
      continue;
    }
    throw new CliError(`Unknown flag: ${flag}`);
  }

  return { pos, opts };
}
