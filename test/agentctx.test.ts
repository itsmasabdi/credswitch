import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const FAKE_AZ = `#!/bin/sh
if [ "$1" = "account" ] && [ "$2" = "show" ]; then
  if [ -n "$AZURE_CONFIG_DIR" ] && [ -f "$AZURE_CONFIG_DIR/whoami" ]; then
    who=$(cat "$AZURE_CONFIG_DIR/whoami")
    printf '{"user":{"name":"%s"},"name":"sub-%s","tenantId":"tenant-%s"}\\n' "$who" "$who" "$who"
    exit 0
  fi
  echo "Please run 'az login' to setup account." >&2
  exit 1
fi
if [ "$1" = "login" ]; then
  if [ -n "$FAKE_AZ_LOGIN_FAIL" ]; then exit 1; fi
  mkdir -p "$AZURE_CONFIG_DIR"
  printf 'fresh-login' > "$AZURE_CONFIG_DIR/whoami"
  exit 0
fi
exit 1
`;

const FAKE_GH = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$GH_CONFIG_DIR" ] && [ -f "$GH_CONFIG_DIR/whoami" ]; then
    echo "Logged in to github.com account $(cat "$GH_CONFIG_DIR/whoami")"
    exit 0
  fi
  echo "You are not logged into any GitHub hosts." >&2
  exit 1
fi
exit 1
`;

interface Fixture {
  tmp: string;
  home: string;
  state: string;
  bin: string;
  configFile: string;
  env: Record<string, string>;
}

function setup(): Fixture {
  // realpath: on macOS os.tmpdir() sits behind the /var -> /private/var symlink
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentctx-")));
  const home = path.join(tmp, "home");
  const state = path.join(tmp, "state");
  const bin = path.join(tmp, "bin");
  for (const dir of [home, state, bin]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(bin, "az"), FAKE_AZ, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  // csw shim so the shell hook can call back into the CLI under test
  fs.writeFileSync(path.join(bin, "csw"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, {
    mode: 0o755
  });

  const configFile = path.join(tmp, "config.json");
  return {
    tmp,
    home,
    state,
    bin,
    configFile,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      AGENTCTX_CONFIG: configFile,
      AGENTCTX_STATE_HOME: state
    }
  };
}

function csw(f: Fixture, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: opts.cwd ?? f.tmp,
    env: { ...f.env, ...(opts.env ?? {}) }
  });
}

function ok(result: ReturnType<typeof spawnSync>, label: string) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stdout}\n${result.stderr}`);
}

function mkStateDir(f: Fixture, name: string, who: string): string {
  const dir = path.join(f.state, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "whoami"), who);
  return dir;
}

/** init + two azure accounts (alice, bob) + a context for each. */
function seedTwoAccounts(f: Fixture) {
  ok(csw(f, ["init"]), "init");
  const aliceDir = mkStateDir(f, "az-alice", "alice");
  const bobDir = mkStateDir(f, "az-bob", "bob");
  ok(csw(f, ["account", "add", "azure", "--name", "alice", "--path", aliceDir]), "add alice");
  ok(csw(f, ["account", "add", "azure", "--name", "bob", "--path", bobDir]), "add bob");
  ok(csw(f, ["context", "add", "ctx-alice", "azure:alice"]), "ctx-alice");
  ok(csw(f, ["context", "add", "ctx-bob", "azure:bob"]), "ctx-bob");
}

test("help prints usage", () => {
  const f = setup();
  const result = csw(f, ["help"]);
  ok(result, "help");
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /azure, claude, codex/);
  assert.match(result.stdout, /DENIED/);
});

test("init creates config and refuses to clobber", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  assert.ok(fs.existsSync(f.configFile));
  const before = fs.readFileSync(f.configFile, "utf8");
  const again = csw(f, ["init"]);
  ok(again, "second init");
  assert.match(again.stdout, /already exists/);
  assert.equal(fs.readFileSync(f.configFile, "utf8"), before);
});

test("two accounts of the same provider stay isolated", () => {
  const f = setup();
  seedTwoAccounts(f);

  const asAlice = csw(f, ["run", "--context", "ctx-alice", "--", "az", "account", "show"]);
  ok(asAlice, "run as alice");
  assert.match(asAlice.stdout, /"alice"/);
  assert.match(asAlice.stdout, /sub-alice/);

  const asBob = csw(f, ["run", "-c", "ctx-bob", "--", "az", "account", "show"]);
  ok(asBob, "run as bob");
  assert.match(asBob.stdout, /"bob"/);
});

test("omitted adapters are denied, token variables never leak", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  ok(csw(f, ["account", "add", "claude", "--system"]), "claude system");
  ok(csw(f, ["context", "add", "solo", "claude:default"]), "solo ctx");

  const probe =
    'printf "%s|%s|%s|%s|%s" "${AZURE_CONFIG_DIR:-unset}" "${GH_TOKEN:-unset}" "${ANTHROPIC_API_KEY:-unset}" "${CLAUDE_CONFIG_DIR:-unset}" "$AGENTCTX_CONTEXT"';
  const result = csw(f, ["run", "-c", "solo", "--", "sh", "-c", probe], {
    env: {
      AZURE_CONFIG_DIR: "/leaky/azure",
      GH_TOKEN: "leaky-token",
      ANTHROPIC_API_KEY: "sk-leaky",
      CLAUDE_CONFIG_DIR: "/leaky/claude"
    }
  });
  ok(result, "hygiene run");
  const deniedAzure = path.join(f.state, "denied", "azure");
  // azure: denied selector; gh/anthropic tokens: cleared; claude: system default (unset)
  assert.equal(result.stdout, `${deniedAzure}|unset|unset|unset|solo`);

  // The denied provider actually fails closed, and the denied root is unwritable.
  const denied = csw(f, ["run", "-c", "solo", "--", "az", "account", "show"]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /az login/);
  const mode = fs.statSync(path.join(f.state, "denied")).mode & 0o777;
  assert.equal(mode & 0o200, 0, "denied root must not be owner-writable");
});

test("system accounts pass the machine default through explicitly", () => {
  const f = setup();
  seedTwoAccounts(f);
  ok(csw(f, ["account", "add", "azure", "--name", "sysaz", "--system"]), "system azure");
  ok(csw(f, ["context", "add", "sysctx", "azure:sysaz"]), "sysctx");

  const result = csw(f, ["run", "-c", "sysctx", "--", "sh", "-c", 'printf "%s" "${AZURE_CONFIG_DIR:-unset}"'], {
    env: { AZURE_CONFIG_DIR: "/leaky/azure" }
  });
  ok(result, "system run");
  assert.equal(result.stdout, "unset");

  const both = csw(f, ["account", "add", "azure", "--name", "bad", "--system", "--path", f.state]);
  assert.notEqual(both.status, 0);
});

test("fresh account add runs the provider login, pins the identity", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const result = csw(f, ["account", "add", "azure", "--name", "fresh"]);
  ok(result, "fresh add");
  assert.match(result.stdout, /Launching login: az login/);
  assert.match(result.stdout, /ok identity: fresh-login.*\(pinned\)/);
  assert.ok(fs.existsSync(path.join(f.state, "azure", "fresh", "whoami")));
  const config = JSON.parse(fs.readFileSync(f.configFile, "utf8"));
  assert.match(config.accounts["azure:fresh"].pin, /fresh-login/);
});

test("failed login saves nothing and removes the fresh state dir", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const result = csw(f, ["account", "add", "azure", "--name", "doomed", "--context", "newctx"], {
    env: { FAKE_AZ_LOGIN_FAIL: "1" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Nothing was saved/);
  assert.ok(!fs.existsSync(path.join(f.state, "azure", "doomed")), "state dir must be removed");
  const config = JSON.parse(fs.readFileSync(f.configFile, "utf8"));
  assert.deepEqual(config.accounts, {});
  assert.deepEqual(config.contexts, {});
});

test("account names are validated before any filesystem use", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const result = csw(f, ["account", "add", "azure", "--name", "../evil"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid account name/);
  assert.ok(!fs.existsSync(path.join(f.state, "evil")), "no directory may escape the state root");
});

test("referenced paths are stored canonically, independent of later cwd", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  mkStateDir(f, "relstate", "reluser");
  // pass a cwd-relative path
  ok(csw(f, ["account", "add", "azure", "--name", "rel", "--path", "relstate"], { cwd: f.state }), "add rel");
  ok(csw(f, ["context", "add", "ctx-rel", "azure:rel"]), "ctx-rel");

  const config = JSON.parse(fs.readFileSync(f.configFile, "utf8"));
  assert.ok(path.isAbsolute(config.accounts["azure:rel"].stateDir));

  const result = csw(f, ["run", "-c", "ctx-rel", "--", "az", "account", "show"], { cwd: f.home });
  ok(result, "run from different cwd");
  assert.match(result.stdout, /"reluser"/);
});

test("fresh accounts refuse a non-empty existing state dir", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const dir = path.join(f.state, "azure", "dup");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "leftover"), "x");
  const result = csw(f, ["account", "add", "azure", "--name", "dup", "--no-login"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not empty/);
});

test("resolver: default, folder binding, nested binding", () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectA = path.join(f.home, "proj-a");
  const nested = path.join(projectA, "sub");
  fs.mkdirSync(nested, { recursive: true });

  ok(csw(f, ["use", "ctx-bob"]), "use default");
  ok(csw(f, ["bind", "ctx-alice", "--dir", projectA]), "bind a");
  ok(csw(f, ["bind", "ctx-bob", "--dir", nested]), "bind nested");

  assert.equal(csw(f, ["current"], { cwd: f.home }).stdout.trim(), "ctx-bob");
  assert.equal(csw(f, ["current"], { cwd: projectA }).stdout.trim(), "ctx-alice");
  assert.equal(csw(f, ["current"], { cwd: nested }).stdout.trim(), "ctx-bob");

  const explain = csw(f, ["current", "--explain"], { cwd: projectA });
  assert.match(explain.stdout, /Source: {2}folder binding at /);
  assert.match(explain.stdout, /azure:alice/);
  assert.match(explain.stdout, /Denied: .*github/);

  const list = fs.readFileSync(path.join(path.dirname(f.configFile), "bindings.list"), "utf8");
  const lines = list.trim().split("\n").sort();
  assert.deepEqual(lines, [`${projectA}\tctx-alice`, `${nested}\tctx-bob`].sort());
  assert.ok(!fs.existsSync(`${f.configFile}.lock`), "lock must be released");
});

test("resolver: pinned shell beats binding, --context flag beats pin", () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectA = path.join(f.home, "proj-a");
  fs.mkdirSync(projectA, { recursive: true });
  ok(csw(f, ["bind", "ctx-alice", "--dir", projectA]), "bind a");

  const pinnedEnv = { AGENTCTX_OVERRIDE: "1", AGENTCTX_CONTEXT: "ctx-bob" };
  const pinned = csw(f, ["current"], { cwd: projectA, env: pinnedEnv });
  assert.equal(pinned.stdout.trim(), "ctx-bob");

  const flag = csw(f, ["run", "-c", "ctx-alice", "--", "sh", "-c", 'printf "%s" "$AGENTCTX_CONTEXT"'], {
    cwd: projectA,
    env: pinnedEnv
  });
  ok(flag, "flag run");
  assert.equal(flag.stdout, "ctx-alice");
});

test("resolver: inherited context beats default, loses to binding", () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectB = path.join(f.home, "proj-b");
  fs.mkdirSync(projectB, { recursive: true });
  ok(csw(f, ["use", "ctx-bob"]), "use");
  ok(csw(f, ["bind", "ctx-bob", "--dir", projectB]), "bind b");

  const inherited = csw(f, ["current", "--explain"], { cwd: f.home, env: { AGENTCTX_CONTEXT: "ctx-alice" } });
  assert.match(inherited.stdout, /Context: ctx-alice/);
  assert.match(inherited.stdout, /inherited from parent process/);

  const bound = csw(f, ["current"], { cwd: projectB, env: { AGENTCTX_CONTEXT: "ctx-alice" } });
  assert.equal(bound.stdout.trim(), "ctx-bob");
});

test("shell prints pinned eval-able exports with safe quoting and denied selectors", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const spaced = mkStateDir(f, "az dir with spaces", "spacey");
  ok(csw(f, ["account", "add", "azure", "--name", "spacey", "--path", spaced]), "add spacey");
  ok(csw(f, ["context", "add", "sp", "azure:spacey"]), "ctx sp");

  const result = csw(f, ["shell", "sp"]);
  ok(result, "shell");
  assert.match(result.stdout, /export AGENTCTX_OVERRIDE='1'/);
  assert.match(result.stdout, /export AGENTCTX_CONTEXT='sp'/);
  assert.ok(result.stdout.includes(`export AZURE_CONFIG_DIR='${spaced}'`));
  assert.ok(result.stdout.includes(`export GH_CONFIG_DIR='${path.join(f.state, "denied", "github")}'`));
  assert.match(result.stdout, /unset GH_TOKEN/);
  assert.match(result.stdout, /unset ANTHROPIC_API_KEY/);

  const off = csw(f, ["shell", "--off"]);
  ok(off, "shell --off");
  assert.match(off.stdout, /unset AGENTCTX_OVERRIDE/);
  assert.match(off.stdout, /unset AZURE_CONFIG_DIR/);
  assert.match(off.stdout, /unset AGENTCTX_HOOK_KEY/);
});

test("env --cwd resolves bindings and default through the real resolver", () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectA = path.join(f.home, "proj-a");
  fs.mkdirSync(projectA, { recursive: true });
  ok(csw(f, ["bind", "ctx-alice", "--dir", projectA]), "bind");

  const bound = csw(f, ["env", "--cwd", projectA]);
  ok(bound, "env bound");
  assert.match(bound.stdout, /export AGENTCTX_BOUND_DIR=/);
  assert.match(bound.stdout, /export AGENTCTX_CONTEXT='ctx-alice'/);
  assert.match(bound.stdout, /unset AGENTCTX_OVERRIDE/);

  // Unbound location + default context -> the default is applied (not cleared).
  ok(csw(f, ["use", "ctx-bob"]), "use");
  const unbound = csw(f, ["env", "--cwd", f.home]);
  ok(unbound, "env default");
  assert.match(unbound.stdout, /export AGENTCTX_CONTEXT='ctx-bob'/);
  assert.match(unbound.stdout, /unset AGENTCTX_BOUND_DIR/);

  // No binding, no default -> everything cleared.
  const fresh = setup();
  seedTwoAccounts(fresh);
  const cleared = csw(fresh, ["env", "--cwd", fresh.home]);
  ok(cleared, "env cleared");
  assert.match(cleared.stdout, /unset AGENTCTX_CONTEXT/);
});

test("one identity per adapter per context is enforced", () => {
  const f = setup();
  seedTwoAccounts(f);
  const result = csw(f, ["context", "add", "dup", "azure:alice", "azure:bob"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /one identity per adapter per context/);
});

test("context set replaces accounts in place", () => {
  const f = setup();
  seedTwoAccounts(f);
  ok(csw(f, ["context", "set", "ctx-alice", "azure:bob"]), "context set");
  const run = csw(f, ["run", "-c", "ctx-alice", "--", "az", "account", "show"]);
  ok(run, "run after set");
  assert.match(run.stdout, /"bob"/);

  const unknown = csw(f, ["context", "set", "nope", "azure:bob"]);
  assert.notEqual(unknown.status, 0);
});

test("account remove refuses while referenced; context remove cleans up", () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectA = path.join(f.home, "proj-a");
  fs.mkdirSync(projectA, { recursive: true });
  ok(csw(f, ["bind", "ctx-alice", "--dir", projectA]), "bind");
  ok(csw(f, ["use", "ctx-alice"]), "use");

  const refuse = csw(f, ["account", "remove", "azure:alice"]);
  assert.notEqual(refuse.status, 0);
  assert.match(refuse.stderr, /used by context\(s\): ctx-alice/);

  const removeCtx = csw(f, ["context", "remove", "ctx-alice"]);
  ok(removeCtx, "context remove");
  assert.match(removeCtx.stdout, /Removed binding/);
  assert.match(removeCtx.stdout, /Cleared global default/);

  const removeAccount = csw(f, ["account", "remove", "azure:alice"]);
  ok(removeAccount, "account remove");
  assert.match(removeAccount.stdout, /was NOT deleted/);
  assert.ok(fs.existsSync(path.join(f.state, "az-alice", "whoami")), "state dir must survive");
});

test("kubernetes accounts require a kubeconfig or --system", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const missingFlag = csw(f, ["account", "add", "kubernetes", "--name", "k"]);
  assert.notEqual(missingFlag.status, 0);
  assert.match(missingFlag.stderr, /--kubeconfig/);

  const missingFile = csw(f, ["account", "add", "kubernetes", "--name", "k", "--kubeconfig", "/nope/kubeconfig"]);
  assert.notEqual(missingFile.status, 0);
  assert.match(missingFile.stderr, /not found/);

  ok(csw(f, ["account", "add", "kubernetes", "--system"]), "kubernetes system");
});

test("unknown adapter lists the available ones", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const result = csw(f, ["account", "add", "nope", "--name", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown adapter: nope/);
  assert.match(result.stderr, /azure/);
});

test("doctor verifies identities and fails on drift until re-pinned", () => {
  const f = setup();
  seedTwoAccounts(f);

  const healthy = csw(f, ["doctor", "ctx-alice"]);
  ok(healthy, "doctor healthy");
  assert.match(healthy.stdout, /ok azure:alice identity: alice — sub-alice.*\(pinned\)/);
  assert.match(healthy.stdout, /denied: .*github/);
  assert.match(healthy.stdout, /All checks passed/);

  // Someone logs the alice state into a different identity -> drift.
  fs.writeFileSync(path.join(f.state, "az-alice", "whoami"), "mallory");
  const drifted = csw(f, ["doctor", "ctx-alice"]);
  assert.equal(drifted.status, 2);
  assert.match(drifted.stdout, /identity drift/);
  assert.match(drifted.stdout, /csw account pin azure:alice/);

  ok(csw(f, ["account", "pin", "azure:alice"]), "re-pin");
  const healed = csw(f, ["doctor", "ctx-alice"]);
  ok(healed, "doctor after re-pin");
  assert.match(healed.stdout, /mallory/);
});

test("account login re-runs the provider login and updates the pin", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const added = csw(f, ["account", "add", "azure", "--name", "later", "--no-login"]);
  ok(added, "add --no-login");
  assert.match(added.stdout, /csw account login azure:later/);

  const login = csw(f, ["account", "login", "azure:later"]);
  ok(login, "account login");
  assert.match(login.stdout, /ok identity: fresh-login.*\(pinned\)/);
  const config = JSON.parse(fs.readFileSync(f.configFile, "utf8"));
  assert.match(config.accounts["azure:later"].pin, /fresh-login/);
});

test("stale config locks are evicted", () => {
  const f = setup();
  seedTwoAccounts(f);
  const lock = `${f.configFile}.lock`;
  fs.writeFileSync(lock, "99999");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, past, past);

  ok(csw(f, ["use", "ctx-alice"]), "use with stale lock");
  assert.ok(!fs.existsSync(lock), "stale lock evicted and released");
});

test("run propagates the child's exit code", () => {
  const f = setup();
  seedTwoAccounts(f);
  const result = csw(f, ["run", "-c", "ctx-alice", "--", "sh", "-c", "exit 7"]);
  assert.equal(result.status, 7);
});

test("hook output is resolver-backed with a fail-closed fallback", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const zsh = csw(f, ["hook", "zsh"]);
  ok(zsh, "hook zsh");
  assert.match(zsh.stdout, /add-zsh-hook chpwd _agentctx_hook/);
  assert.match(zsh.stdout, /csw env --cwd/);
  assert.match(zsh.stdout, /unset .*AZURE_CONFIG_DIR/);
  assert.ok(zsh.stdout.includes("bindings.list"));

  const bash = csw(f, ["hook", "bash"]);
  ok(bash, "hook bash");
  assert.match(bash.stdout, /PROMPT_COMMAND/);
  assert.match(bash.stdout, /pwd -P/);

  const bad = csw(f, ["hook", "fish"]);
  assert.notEqual(bad.status, 0);
});

const zshAvailable = spawnSync("zsh", ["--version"], { stdio: "ignore" }).status === 0;

test("zsh hook applies bindings, default, and clears on leave", { skip: !zshAvailable }, () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectA = path.join(f.home, "proj-a");
  const nested = path.join(projectA, "sub");
  fs.mkdirSync(nested, { recursive: true });
  ok(csw(f, ["use", "ctx-bob"]), "use");
  ok(csw(f, ["bind", "ctx-alice", "--dir", projectA]), "bind");

  const script = `
eval "$(csw hook zsh)"
echo "start:\${AGENTCTX_CONTEXT:-none}"
cd ${nested}
echo "nested:\${AGENTCTX_CONTEXT:-none}"
cd /
echo "out:\${AGENTCTX_CONTEXT:-none}:\${AZURE_CONFIG_DIR:+set}"
`;
  const result = spawnSync("zsh", ["-f", "-c", script], {
    encoding: "utf8",
    cwd: f.home,
    env: f.env
  });
  assert.equal(result.status, 0, result.stderr);
  // default applies at shell start, binding wins inside the tree, default returns on leave
  assert.match(result.stdout, /start:ctx-bob/);
  assert.match(result.stdout, /nested:ctx-alice/);
  assert.match(result.stdout, /out:ctx-bob:set/);
});
