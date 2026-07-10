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
  who="unknown"
  if [ -n "$AZURE_CONFIG_DIR" ] && [ -f "$AZURE_CONFIG_DIR/whoami" ]; then
    who=$(cat "$AZURE_CONFIG_DIR/whoami")
  fi
  printf '{"user":{"name":"%s"},"name":"sub-%s","tenantId":"tenant-%s"}\\n' "$who" "$who" "$who"
  exit 0
fi
if [ "$1" = "login" ]; then
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

test("managed variables from the shell never leak into a context", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  ok(csw(f, ["account", "add", "claude", "--system"]), "claude system");
  ok(csw(f, ["context", "add", "solo", "claude:default"]), "solo ctx");

  const result = csw(
    f,
    ["run", "-c", "solo", "--", "sh", "-c", 'printf "%s|%s|%s" "${AZURE_CONFIG_DIR:-unset}" "${GH_TOKEN:-unset}" "$AGENTCTX_CONTEXT"'],
    { env: { AZURE_CONFIG_DIR: "/leaky/azure", GH_TOKEN: "leaky-token" } }
  );
  ok(result, "hygiene run");
  assert.equal(result.stdout, "unset|unset|solo");
});

test("fresh account add runs the provider login into isolated state", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const result = csw(f, ["account", "add", "azure", "--name", "fresh"]);
  ok(result, "fresh add");
  assert.match(result.stdout, /Launching login: az login/);
  assert.match(result.stdout, /ok identity: fresh-login/);
  assert.ok(fs.existsSync(path.join(f.state, "azure", "fresh", "whoami")));
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
  assert.match(explain.stdout, /Cleared: .*GH_CONFIG_DIR/);

  const list = fs.readFileSync(path.join(path.dirname(f.configFile), "bindings.list"), "utf8");
  assert.deepEqual(list.trim().split("\n").sort(), [projectA, nested].sort());
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

test("shell prints pinned eval-able exports with safe quoting", () => {
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
  assert.match(result.stdout, /unset GH_CONFIG_DIR/);
  assert.match(result.stdout, /unset GH_TOKEN/);

  const off = csw(f, ["shell", "--off"]);
  ok(off, "shell --off");
  assert.match(off.stdout, /unset AGENTCTX_OVERRIDE/);
  assert.match(off.stdout, /unset AZURE_CONFIG_DIR/);
});

test("env plumbing for the hook: --dir applies binding, --clear resets", () => {
  const f = setup();
  seedTwoAccounts(f);
  const projectA = path.join(f.home, "proj-a");
  fs.mkdirSync(projectA, { recursive: true });
  ok(csw(f, ["bind", "ctx-alice", "--dir", projectA]), "bind");

  const applied = csw(f, ["env", "--dir", projectA]);
  ok(applied, "env --dir");
  assert.match(applied.stdout, /export AGENTCTX_BOUND_DIR=/);
  assert.match(applied.stdout, /export AGENTCTX_CONTEXT='ctx-alice'/);
  assert.match(applied.stdout, /unset AGENTCTX_OVERRIDE/);

  const cleared = csw(f, ["env", "--clear"]);
  ok(cleared, "env --clear");
  assert.match(cleared.stdout, /unset AGENTCTX_BOUND_DIR/);
  assert.match(cleared.stdout, /unset AGENTCTX_CONTEXT/);
});

test("one identity per adapter per context is enforced", () => {
  const f = setup();
  seedTwoAccounts(f);
  const result = csw(f, ["context", "add", "dup", "azure:alice", "azure:bob"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /one identity per adapter per context/);
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

test("kubernetes accounts require an existing kubeconfig", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const missingFlag = csw(f, ["account", "add", "kubernetes", "--name", "k"]);
  assert.notEqual(missingFlag.status, 0);
  assert.match(missingFlag.stderr, /--kubeconfig/);

  const missingFile = csw(f, ["account", "add", "kubernetes", "--name", "k", "--kubeconfig", "/nope/kubeconfig"]);
  assert.notEqual(missingFile.status, 0);
  assert.match(missingFile.stderr, /not found/);
});

test("unknown adapter lists the available ones", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const result = csw(f, ["account", "add", "nope", "--name", "x"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown adapter: nope/);
  assert.match(result.stderr, /azure/);
});

test("doctor verifies identities and fails on missing state", () => {
  const f = setup();
  seedTwoAccounts(f);

  const healthy = csw(f, ["doctor", "ctx-alice"]);
  ok(healthy, "doctor healthy");
  assert.match(healthy.stdout, /ok azure:alice identity: alice — sub-alice/);
  assert.match(healthy.stdout, /All checks passed/);

  const config = JSON.parse(fs.readFileSync(f.configFile, "utf8"));
  config.accounts["azure:alice"].stateDir = "/definitely/missing";
  fs.writeFileSync(f.configFile, JSON.stringify(config));
  const broken = csw(f, ["doctor", "ctx-alice"]);
  assert.equal(broken.status, 2);
  assert.match(broken.stdout, /missing/);
});

test("run propagates the child's exit code", () => {
  const f = setup();
  seedTwoAccounts(f);
  const result = csw(f, ["run", "-c", "ctx-alice", "--", "sh", "-c", "exit 7"]);
  assert.equal(result.status, 7);
});

test("hook output targets the right shells and bindings list", () => {
  const f = setup();
  ok(csw(f, ["init"]), "init");
  const zsh = csw(f, ["hook", "zsh"]);
  ok(zsh, "hook zsh");
  assert.match(zsh.stdout, /add-zsh-hook chpwd _agentctx_chpwd/);
  assert.ok(zsh.stdout.includes("bindings.list"));

  const bash = csw(f, ["hook", "bash"]);
  ok(bash, "hook bash");
  assert.match(bash.stdout, /PROMPT_COMMAND/);

  const bad = csw(f, ["hook", "fish"]);
  assert.notEqual(bad.status, 0);
});
