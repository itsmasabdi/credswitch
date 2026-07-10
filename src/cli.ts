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
  cmdRun,
  cmdShell,
  cmdUnbind,
  cmdUse
} from "./commands.js";
import { adapterNames } from "./adapters.js";
import { configPath, stateRoot } from "./paths.js";
import { CliError, redactHome } from "./util.js";

const VERSION = "0.2.0";

function printHelp(): void {
  console.log(`agentctx ${VERSION} — one identity context per project, for every CLI and AI agent.

Usage:
  csw init                                     create the config file
  csw account add <adapter> --name <name>      fresh isolated account (launches the provider's login)
      [--path <dir>]                           ...or reference existing provider state (never copied)
      [--kubeconfig <file>]                    ...kubernetes: reference a kubeconfig file
      [--system]                               ...explicitly use the machine's default login
      [--context <ctx>] [--no-login]
  csw account list
  csw account login <adapter>:<name>           (re)run the provider's login for an account
  csw account pin <adapter>:<name>             record the current identity; doctor fails on drift
  csw account remove <adapter>:<name>          config only — never deletes credential state
  csw context add <name> <adapter>:<acct> ...  compose accounts into a context
  csw context set <name> <adapter>:<acct> ...  replace a context's accounts
  csw context remove <name>
  csw list                                     contexts, accounts, bindings
  csw use <context>                            set the global default context
  csw bind <context> [--dir <dir>]             this folder tree selects <context>
  csw unbind [--dir <dir>]
  csw current [--explain]                      resolved context (and why)
  csw run [--context <ctx>] -- <cmd> [args]    run one command inside the context
  csw shell [<context>]                        eval-able exports; pins this shell
  csw shell --off                              unpin and clear managed variables
  csw hook <zsh|bash>                          auto-switch hook for your shell rc
  csw doctor [<context>]                       verify paths, CLIs, live identities, drift

Adapters: ${adapterNames().join(", ")}
An adapter a context omits is DENIED (its CLI sees empty, read-only state).
Use an explicit --system account to pass the machine default through.

Context resolution order:
  --context flag → pinned shell (csw shell) → nearest folder binding
  → inherited (AGENTCTX_CONTEXT) → default (csw use) → none

Environment:
  AGENTCTX_CONFIG        override config file   (default ${redactHome(configPath())})
  AGENTCTX_STATE_HOME    override state root    (default ${redactHome(stateRoot())})`);
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
