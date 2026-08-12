import fs from "node:fs";
import { getAdapter, type AccountConfig } from "../adapters.js";
import { repairCodexAccountMarketplace, type CodexMarketplaceState } from "../codex-state.js";
import { loadConfig, writeBindingsList } from "../config.js";
import { deniedAdapters } from "../env.js";
import { cliInstalled, probeIdentities } from "../identity.js";
import { configPath, stateRoot } from "../paths.js";
import { CliError, parseArgs, redactHome } from "../util.js";
import { emitJson, unknownContext } from "./shared.js";

interface PathCheck {
  field: "stateDir" | "kubeconfig";
  path: string;
  exists: boolean;
}

interface AccountReport {
  id: string;
  adapter: string;
  cli: string;
  cliInstalled: boolean;
  paths: PathCheck[];
  marketplace: CodexMarketplaceState | null;
  identity: { ok: boolean; summary: string; pin: string | null; drift: boolean } | null;
  ok: boolean;
}

interface DoctorReport {
  ok: boolean;
  configPath: string;
  stateRoot: string;
  contexts: Array<{
    name: string;
    description: string | null;
    denied: string[];
    accounts: AccountReport[];
  }>;
}

export async function cmdDoctor(args: string[]): Promise<void> {
  const { pos, opts } = parseArgs(args, { boolFlags: { "--json": "json" } });
  if (pos.length > 1) throw new CliError("Usage: csw doctor [<context>] [--json]");
  const config = loadConfig();
  writeBindingsList(config); // heal a hand-edited config's hook list

  if (pos[0] && !config.contexts[pos[0]]) throw unknownContext(config, pos[0]);
  const names = pos[0] ? [pos[0]] : Object.keys(config.contexts).sort();

  if (names.length === 0) {
    if (opts.json) emitJson({ ok: true, configPath: configPath(), stateRoot: stateRoot(), contexts: [] });
    else console.log("No contexts configured.");
    return;
  }

  // One report per distinct account, not per (context, account) pair: an
  // account shared by five contexts is checked once. Identity probes are
  // network round trips, so they all run concurrently.
  const distinct = new Map<string, AccountConfig>();
  for (const name of names) {
    for (const id of config.contexts[name].accounts) distinct.set(id, config.accounts[id]);
  }
  const probeable = [...distinct.entries()]
    .filter(([, account]) => getAdapter(account.adapter).identity && cliInstalled(getAdapter(account.adapter).cli))
    .map(([id, account]) => ({ id, account }));
  const identities = await probeIdentities(probeable);

  const reports = new Map<string, AccountReport>();
  for (const [id, account] of distinct) reports.set(id, buildAccountReport(id, account, identities.get(id)));

  const report: DoctorReport = {
    ok: [...reports.values()].every((r) => r.ok),
    configPath: configPath(),
    stateRoot: stateRoot(),
    contexts: names.map((name) => ({
      name,
      description: config.contexts[name].description ?? null,
      denied: deniedAdapters(config, name),
      accounts: config.contexts[name].accounts.map((id) => reports.get(id)!)
    }))
  };

  if (opts.json) emitJson(report);
  else renderText(report);

  if (!report.ok) throw new CliError(opts.json ? "" : "\nDoctor found issues.", 2);
}

function buildAccountReport(
  id: string,
  account: AccountConfig,
  identity: { ok: boolean; summary: string } | undefined
): AccountReport {
  const adapter = getAdapter(account.adapter);
  const paths: PathCheck[] = [];
  for (const field of ["stateDir", "kubeconfig"] as const) {
    const value = account[field];
    if (value) paths.push({ field, path: value, exists: fs.existsSync(value) });
  }

  const marketplace =
    account.adapter === "codex" && !account.system && account.stateDir
      ? repairCodexAccountMarketplace(account) ?? null
      : null;

  const installed = cliInstalled(adapter.cli);
  const drift = Boolean(identity?.ok && account.pin && identity.summary !== account.pin);
  const identityReport = identity
    ? { ok: identity.ok, summary: identity.summary, pin: account.pin ?? null, drift }
    : null;

  const ok =
    paths.every((p) => p.exists) &&
    marketplace?.kind !== "unsupported" &&
    marketplace?.kind !== "failed" &&
    installed &&
    (identityReport === null || (identityReport.ok && !identityReport.drift));

  return { id, adapter: account.adapter, cli: adapter.cli, cliInstalled: installed, paths, marketplace, identity: identityReport, ok };
}

function renderText(report: DoctorReport): void {
  console.log(`Config: ${redactHome(report.configPath)}`);
  console.log(`State:  ${redactHome(report.stateRoot)}`);

  for (const context of report.contexts) {
    console.log(`\n${context.name}${context.description ? ` — ${context.description}` : ""}`);
    for (const account of context.accounts) {
      for (const check of account.paths) {
        const mark = check.exists ? "ok" : "! ";
        const missing = check.exists ? "" : "missing ";
        console.log(`  ${mark} ${account.id} ${check.field}: ${missing}${redactHome(check.path)}`);
      }

      const market = account.marketplace;
      if (market?.kind === "repaired") {
        console.log(
          `  ok ${account.id} bundled marketplace: repaired ${redactHome(market.previousSource)} → ${redactHome(market.expectedSource)}`
        );
      } else if (market?.kind === "aligned") {
        console.log(`  ok ${account.id} bundled marketplace: ${redactHome(market.expectedSource)}`);
      } else if (market?.kind === "unsupported" || market?.kind === "failed") {
        console.log(`  !  ${account.id} bundled marketplace: ${market.reason}`);
      }

      if (!account.cliInstalled) {
        console.log(`  !  ${account.id}: '${account.cli}' is not installed`);
        continue;
      }
      const identity = account.identity;
      if (!identity) continue;
      if (!identity.ok) {
        console.log(`  !  ${account.id} identity: ${identity.summary}`);
      } else if (identity.drift) {
        console.log(`  !  ${account.id} identity drift:`);
        console.log(`       pinned: ${identity.pin}`);
        console.log(`       actual: ${identity.summary}`);
        console.log(`       accept the new identity with: csw account pin ${account.id}`);
      } else {
        console.log(`  ok ${account.id} identity: ${identity.summary}${identity.pin ? " (pinned)" : ""}`);
      }
    }
    if (context.denied.length > 0) {
      console.log(`  -- denied: ${context.denied.join(", ")} (not in this context)`);
    }
  }

  if (report.ok) console.log("\nAll checks passed.");
}
