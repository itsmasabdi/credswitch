#!/usr/bin/env node
import {
  cmdAccount,
  cmdBind,
  cmdContext,
  cmdCurrent,
  cmdDoctor,
  cmdEnv,
  cmdHook,
  cmdInit,
  cmdList,
  cmdLocal,
  cmdLogin,
  cmdRun,
  cmdSetup,
  cmdShell,
  cmdUnbind,
  cmdUse
} from "./commands.js";
import { adapterNames } from "./adapters.js";
import { configPath, stateRoot } from "./paths.js";
import { CliError, redactHome } from "./util.js";

const VERSION = "0.3.1";

function printHelp(): void {
  console.log(`credswitch ${VERSION} — every folder gets its own identity, for every CLI and AI agent.

Everyday:
  csw setup                                    one-time: config + shell hook (auto-switching)
  csw login <adapter> [--as <n>] [--global]    give THIS folder its own <adapter> identity
  csw local [<context>]                        bind this folder to a named context (blank: show)
  csw current [--explain]                      resolved context (and why)
  csw run [--context <ctx>] -- <cmd> [args]    run one command inside a context
  csw list                                     contexts, accounts, bindings
  csw doctor [<context>]                       verify paths, CLIs, live identities, drift

Plumbing:
  csw init                                     create the config file only
  csw account add <adapter> --name <n> [--path <dir>] [--kubeconfig <f>] [--system] [--context <c>] [--no-login]
  csw account list | login <id> | pin <id> | remove <id>
  csw context add|set <name> <adapter>:<acct> ... | remove <name>
  csw use <context>                            set the global default context
  csw bind <context> [--dir <dir>] | unbind [--dir <dir>]
  csw shell [<context>] | --off                pin / unpin this shell (eval-able)
  csw hook <zsh|bash>                          print the auto-switch hook
  csw env --cwd <dir> | --clear                hook plumbing

Adapters: ${adapterNames().join(", ")}
An adapter a context omits is DENIED (its CLI sees empty, read-only state).
A folder only gains an identity when YOU run 'csw login' inside it — never from a repo.

Context resolution order:
  --context flag → pinned shell (csw shell) → nearest folder binding
  → inherited (CREDSWITCH_CONTEXT) → default (csw use) → none

Environment:
  CREDSWITCH_CONFIG        override config file   (default ${redactHome(configPath())})
  CREDSWITCH_STATE_HOME    override state root    (default ${redactHome(stateRoot())})`);
}

function main(): void {
  const [, , rawCommand, ...args] = process.argv;
  const command = rawCommand || "help";

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        return printHelp();
      case "version":
      case "--version":
      case "-v":
        return console.log(VERSION);
      case "setup":
        return cmdSetup(args);
      case "login":
        return cmdLogin(args);
      case "local":
        return cmdLocal(args);
      case "init":
        return cmdInit(args);
      case "account":
        return cmdAccount(args);
      case "context":
        return cmdContext(args);
      case "list":
        return cmdList(args);
      case "use":
        return cmdUse(args);
      case "bind":
        return cmdBind(args);
      case "unbind":
        return cmdUnbind(args);
      case "current":
        return cmdCurrent(args);
      case "run":
        return cmdRun(args);
      case "shell":
        return cmdShell(args);
      case "env":
        return cmdEnv(args);
      case "hook":
        return cmdHook(args);
      case "doctor":
        return cmdDoctor(args);
      default:
        throw new CliError(`Unknown command: ${command}\nRun 'csw help' for usage.`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    throw error;
  }
}

main();
