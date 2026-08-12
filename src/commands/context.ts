import { loadConfig, mutateConfig } from "../config.js";
import { deniedAdapters } from "../env.js";
import { CliError, parseArgs, redactHome } from "../util.js";
import { describeAccount, emitJson, unknownContext } from "./shared.js";

export function cmdContext(args: string[]): void {
  const [sub, ...rest] = args;
  switch (sub) {
    case "add":
      return contextAdd(rest);
    case "set":
      return contextSet(rest);
    case "remove":
      return contextRemove(rest);
    default:
      throw new CliError("Usage: csw context <add|set|remove> ...");
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

  const config = mutateConfig((c) => {
    if (c.contexts[name]) {
      throw new CliError(
        `Context '${name}' already exists.\n` +
          `Replace its accounts with: csw context set ${name} <accounts...>\n` +
          `Or append one with: csw account add <adapter> --name <n> --context ${name}`
      );
    }
    c.contexts[name] = {
      ...(opts.description ? { description: opts.description as string } : {}),
      accounts: accountIds
    };
  });

  console.log(`Context added: ${name} [${accountIds.join(", ")}]`);
  const denied = deniedAdapters(config, name);
  if (denied.length > 0) console.log(`Denied in this context: ${denied.join(", ")} (add accounts to enable)`);
  if (!config.defaultContext) console.log(`Tip: csw use ${name}   # make it the global default`);
}

function contextSet(args: string[]): void {
  const { pos, opts } = parseArgs(args, {
    valueFlags: { "--description": "description", "-d": "description" }
  });
  if (pos.length < 2) {
    throw new CliError("Usage: csw context set <name> <adapter>:<account> [...more] [--description <text>]");
  }
  const [name, ...accountIds] = pos;

  mutateConfig((c) => {
    const existing = c.contexts[name];
    if (!existing) {
      throw new CliError(`${unknownContext(c, name).message}\nCreate it with: csw context add`);
    }
    existing.accounts = accountIds;
    if (opts.description) existing.description = opts.description as string;
  });
  console.log(`Context updated: ${name} [${accountIds.join(", ")}]`);
}

function contextRemove(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw context remove <name>");
  const name = pos[0];

  const messages: string[] = [];
  mutateConfig((config) => {
    if (!config.contexts[name]) throw new CliError(`Unknown context: ${name}`);
    delete config.contexts[name];
    for (const [dir, ctx] of Object.entries(config.bindings)) {
      if (ctx === name) {
        delete config.bindings[dir];
        messages.push(`Removed binding: ${redactHome(dir)}`);
      }
    }
    if (config.defaultContext === name) {
      delete config.defaultContext;
      messages.push("Cleared global default context.");
    }
  });
  for (const message of messages) console.log(message);
  console.log(`Context removed: ${name} (accounts and credential state untouched)`);
}

export function cmdList(args: string[]): void {
  const { pos, opts } = parseArgs(args, { boolFlags: { "--json": "json" } });
  if (pos.length > 0) throw new CliError("Usage: csw list [--json]");
  const config = loadConfig();
  const names = Object.keys(config.contexts).sort();
  const accountIds = Object.keys(config.accounts).sort();
  const bindingsFor = (name: string) =>
    Object.entries(config.bindings)
      .filter(([, ctx]) => ctx === name)
      .map(([dir]) => dir)
      .sort();

  if (opts.json) {
    emitJson({
      defaultContext: config.defaultContext ?? null,
      contexts: names.map((name) => ({
        name,
        description: config.contexts[name].description ?? null,
        accounts: config.contexts[name].accounts,
        bindings: bindingsFor(name),
        denied: deniedAdapters(config, name)
      })),
      accounts: accountIds.map((id) => ({ id, ...config.accounts[id] }))
    });
    return;
  }

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
    for (const dir of bindingsFor(name)) console.log(`     bound: ${redactHome(dir)}`);
  }

  if (accountIds.length > 0) {
    console.log("Accounts:");
    for (const id of accountIds) console.log(`  ${id}  ${describeAccount(config.accounts[id])}`);
  }
  if (config.defaultContext) console.log(`Default: ${config.defaultContext} (marked *)`);
}

export function cmdUse(args: string[]): void {
  const { pos } = parseArgs(args);
  if (pos.length !== 1) throw new CliError("Usage: csw use <context>");
  mutateConfig((config) => {
    if (!config.contexts[pos[0]]) throw unknownContext(config, pos[0]);
    config.defaultContext = pos[0];
  });
  console.log(`Global default context: ${pos[0]}`);
  console.log("Folder bindings and pinned shells still take precedence over the default.");
}
