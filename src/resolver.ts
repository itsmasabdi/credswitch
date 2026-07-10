import path from "node:path";
import type { Config } from "./config.js";
import { CliError, realpathSafe } from "./util.js";

export type ContextSource = "flag" | "shell-override" | "binding" | "default" | "none";

export interface Resolution {
  name: string | null;
  source: ContextSource;
  bindingDir?: string;
}

export interface ResolveOptions {
  flag?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Single resolver used by every command.
 * Precedence: --context flag → pinned shell (csw shell) → nearest folder binding → global default → none.
 */
export function resolveContext(config: Config, opts: ResolveOptions): Resolution {
  if (opts.flag) {
    assertContext(config, opts.flag, `--context ${opts.flag}`);
    return { name: opts.flag, source: "flag" };
  }

  if (opts.env.AGENTCTX_OVERRIDE === "1" && opts.env.AGENTCTX_CONTEXT) {
    const name = opts.env.AGENTCTX_CONTEXT;
    if (!config.contexts[name]) {
      throw new CliError(
        `This shell is pinned to context '${name}', which no longer exists.\n` +
          `Run 'eval "$(csw shell --off)"' to unpin, or recreate the context.`
      );
    }
    return { name, source: "shell-override" };
  }

  let dir = realpathSafe(path.resolve(opts.cwd));
  for (;;) {
    const bound = config.bindings[dir];
    if (bound) {
      if (!config.contexts[bound]) {
        throw new CliError(
          `Folder ${dir} is bound to context '${bound}', which no longer exists.\n` +
            `Run 'csw unbind --dir ${dir}' or recreate the context.`
        );
      }
      return { name: bound, source: "binding", bindingDir: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (config.defaultContext) {
    assertContext(config, config.defaultContext, "defaultContext");
    return { name: config.defaultContext, source: "default" };
  }

  return { name: null, source: "none" };
}

function assertContext(config: Config, name: string, where: string): void {
  if (!config.contexts[name]) {
    const known = Object.keys(config.contexts).sort().join(", ") || "(none)";
    throw new CliError(`Unknown context '${name}' (${where}).\nKnown contexts: ${known}`);
  }
}

export function describeSource(res: Resolution): string {
  switch (res.source) {
    case "flag":
      return "--context flag";
    case "shell-override":
      return "pinned shell (csw shell)";
    case "binding":
      return `folder binding at ${res.bindingDir}`;
    case "default":
      return "global default (csw use)";
    case "none":
      return "none";
  }
}
