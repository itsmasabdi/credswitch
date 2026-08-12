import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountConfig } from "./adapters.js";
import { atomicWrite, realpathSafe, withLock } from "./util.js";

const BUNDLED_MARKETPLACE_SECTION =
  /^\s*\[\s*marketplaces\s*\.\s*(?:openai-bundled|"openai-bundled"|'openai-bundled')\s*\]\s*(?:#.*)?$/;
const ANY_SECTION = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
const SOURCE_LINE = /^(\s*source\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/;
const SOURCE_TYPE_LINE = /^\s*source_type\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/;

export type CodexMarketplaceState =
  | { kind: "absent"; configFile: string; expectedSource: string }
  | { kind: "aligned"; configFile: string; expectedSource: string; source: string }
  | { kind: "misaligned"; configFile: string; expectedSource: string; source: string }
  | { kind: "repaired"; configFile: string; expectedSource: string; previousSource: string }
  | { kind: "unsupported"; configFile: string; expectedSource: string; reason: string }
  /** The rewrite was attempted and failed (unwritable profile, lock contention). */
  | { kind: "failed"; configFile: string; expectedSource: string; reason: string };

interface Line {
  start: number;
  body: string;
}

interface Analysis {
  state: CodexMarketplaceState;
  replacement?: { start: number; end: number; text: string };
  content?: string;
  mode?: number;
}

export function bundledMarketplaceSource(codexHome: string): string {
  return path.join(path.resolve(codexHome), ".tmp", "bundled-marketplaces", "openai-bundled");
}

function tomlString(value: string): string | null {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (!value.startsWith('"') || !value.endsWith('"')) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function configuredPath(value: string): string | null {
  let expanded = value;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  expanded = expanded.replace(/\$HOME\b/g, os.homedir());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
}

function linesOf(content: string): Line[] {
  const lines: Line[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (;;) {
    const match = pattern.exec(content);
    if (!match || match[0] === "") break;
    const body = match[0].replace(/(?:\r\n|\n|\r)$/, "");
    lines.push({ start: match.index, body });
  }
  return lines;
}

function analyse(codexHome: string): Analysis {
  const home = path.resolve(codexHome);
  const configFile = path.join(home, "config.toml");
  const expectedSource = bundledMarketplaceSource(home);

  if (!fs.existsSync(configFile)) {
    return { state: { kind: "absent", configFile, expectedSource } };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configFile);
  } catch (error) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: `cannot inspect config.toml: ${(error as Error).message}`
      }
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: "config.toml is a symlink; left unchanged"
      }
    };
  }
  if (!stat.isFile()) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: "config.toml is not a regular file"
      }
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(configFile, "utf8");
  } catch (error) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: `cannot read config.toml: ${(error as Error).message}`
      }
    };
  }

  const lines = linesOf(content);
  const sectionIndexes = lines
    .map((line, index) => (BUNDLED_MARKETPLACE_SECTION.test(line.body) ? index : -1))
    .filter((index) => index >= 0);
  if (sectionIndexes.length === 0) {
    return { state: { kind: "absent", configFile, expectedSource }, content, mode: stat.mode & 0o777 };
  }
  if (sectionIndexes.length !== 1) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: "multiple [marketplaces.openai-bundled] sections; left unchanged"
      }
    };
  }

  const sectionStart = sectionIndexes[0] + 1;
  let sectionEnd = lines.length;
  for (let index = sectionStart; index < lines.length; index++) {
    if (ANY_SECTION.test(lines[index].body)) {
      sectionEnd = index;
      break;
    }
  }
  const section = lines.slice(sectionStart, sectionEnd);
  const sourceTypes = section
    .map((line) => line.body.match(SOURCE_TYPE_LINE))
    .filter((match): match is RegExpMatchArray => Boolean(match));
  if (sourceTypes.length !== 1 || tomlString(sourceTypes[0][1]) !== "local") {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: "openai-bundled is not a single local marketplace source; left unchanged"
      }
    };
  }

  const sources = section
    .map((line) => ({ line, match: line.body.match(SOURCE_LINE) }))
    .filter((entry): entry is { line: Line; match: RegExpMatchArray } => Boolean(entry.match));
  if (sources.length !== 1) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: "openai-bundled has no single-line local source; left unchanged"
      }
    };
  }

  const { line, match } = sources[0];
  const sourceValue = tomlString(match[2]);
  const source = sourceValue === null ? null : configuredPath(sourceValue);
  if (!source) {
    return {
      state: {
        kind: "unsupported",
        configFile,
        expectedSource,
        reason: "openai-bundled source is not an absolute path; left unchanged"
      }
    };
  }

  if (realpathSafe(source) === realpathSafe(expectedSource)) {
    return {
      state: { kind: "aligned", configFile, expectedSource, source },
      content,
      mode: stat.mode & 0o777
    };
  }

  return {
    state: { kind: "misaligned", configFile, expectedSource, source },
    replacement: {
      start: line.start,
      end: line.start + line.body.length,
      text: `${match[1]}${JSON.stringify(expectedSource)}${match[3]}`
    },
    content,
    mode: stat.mode & 0o777
  };
}

export function inspectCodexBundledMarketplace(codexHome: string): CodexMarketplaceState {
  return analyse(codexHome).state;
}

/**
 * Rebase Codex's app-owned bundled marketplace onto the active CODEX_HOME.
 *
 * Codex persists this absolute local path in config.toml. If a profile was
 * imported or first initialized under another CODEX_HOME, the path can keep
 * reading that other profile's stale bundled Browser/Chrome builds after an
 * app update. Only this reserved marketplace section is changed; credentials,
 * other marketplaces, plugin choices, and caches are not touched.
 *
 * NEVER throws. This is one adapter's cosmetic self-heal; an unwritable Codex
 * profile must not be able to fail a command — and it must never reach the
 * shell hook, which reads any non-zero exit as "resolution failed" and denies
 * every provider in every shell. Failures come back as `failed` for `doctor`
 * to report.
 */
export function repairCodexBundledMarketplace(codexHome: string): CodexMarketplaceState {
  const initial = analyse(codexHome);
  if (initial.state.kind !== "misaligned") return initial.state;

  const lockFile = `${initial.state.configFile}.credswitch-marketplace.lock`;
  try {
    return withLock(lockFile, () => {
      // Codex may have rewritten its config while we waited for our lock.
      const current = analyse(codexHome);
      if (current.state.kind !== "misaligned") return current.state;
      if (!current.content || !current.replacement) return current.state;

      const { start, end, text } = current.replacement;
      const updated = `${current.content.slice(0, start)}${text}${current.content.slice(end)}`;
      atomicWrite(current.state.configFile, updated, current.mode || 0o600);
      return {
        kind: "repaired",
        configFile: current.state.configFile,
        expectedSource: current.state.expectedSource,
        previousSource: current.state.source
      };
    });
  } catch (error) {
    return {
      kind: "failed",
      configFile: initial.state.configFile,
      expectedSource: initial.state.expectedSource,
      reason: `could not rewrite the bundled marketplace source: ${(error as Error).message}`
    };
  }
}

export function repairCodexAccountMarketplace(account: AccountConfig): CodexMarketplaceState | undefined {
  if (account.adapter !== "codex" || account.system || !account.stateDir) return undefined;
  return repairCodexBundledMarketplace(account.stateDir);
}
