import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateRoot } from "./paths.js";
import { CliError, ensureDir, expandPath } from "./util.js";

export interface AccountConfig {
  adapter: string;
  /** Isolated provider state directory (most adapters). */
  stateDir?: string;
  /** kubeconfig file path (kubernetes adapter). */
  kubeconfig?: string;
  /** Explicitly use the provider's system default login. */
  system?: boolean;
  /** Identity summary captured at enrollment; doctor fails on drift. */
  pin?: string;
}

export interface IdentitySpec {
  argv: string[];
  parse(stdout: string, stderr: string, status: number | null): { ok: boolean; summary: string };
}

export interface Adapter {
  name: string;
  label: string;
  /** Binary used for login/identity checks. */
  cli: string;
  /**
   * Every credential channel this adapter owns: state-dir selectors, token
   * variables, host selectors. All of them are cleared before any context is
   * applied — nothing on this list can leak from the calling shell.
   */
  managedEnv: string[];
  /**
   * Environment that denies this provider when a context omits it: selectors
   * point into the read-only denied root, so the CLI reports not-logged-in
   * (or fails to write state) instead of silently using the machine default.
   */
  deniedEnv(deniedRoot: string): Record<string, string>;
  validateAccount(account: AccountConfig): string | null;
  /** Never called for system accounts — those leave every managed var unset. */
  envFor(account: AccountConfig): Record<string, string | null>;
  /** Where `account add` creates fresh isolated state. */
  freshStateDir?(accountName: string): string;
  /**
   * Idempotently create any structure the provider expects to already exist
   * inside the state directory. Runs before login and identity checks, for
   * both fresh and `--path` accounts.
   */
  prepareStateDir?(account: AccountConfig): void;
  /** Native login command to run inside the account's environment. */
  loginCommand?(account: AccountConfig): string[];
  identity?(account: AccountConfig): IdentitySpec;
}

function validateStateDirAccount(account: AccountConfig): string | null {
  if (account.system) {
    return account.stateDir || account.kubeconfig ? "system accounts take no --path/--kubeconfig" : null;
  }
  if (!account.stateDir) return "missing 'stateDir' (or set 'system: true' for the machine default)";
  return null;
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
}

/** Set by any profile that authenticates through IAM Identity Center. */
const SSO_PROFILE_KEY = /^\s*(?:sso_session|sso_start_url)\s*=/m;

function awsConfigFile(account: AccountConfig): string {
  return account.system
    ? path.join(os.homedir(), ".aws", "config")
    : path.join(expandPath(account.stateDir!), "config");
}

/**
 * Identity Center profiles re-auth with `aws sso login`; console sessions —
 * and a brand-new empty state directory — use `aws login`.
 */
function usesSso(account: AccountConfig): boolean {
  try {
    return SSO_PROFILE_KEY.test(fs.readFileSync(awsConfigFile(account), "utf8"));
  } catch {
    return false;
  }
}

/**
 * AWS has no single config-directory variable, so isolation redirects all
 * three writable channels the CLI owns: both profile files and the `aws login`
 * credential cache. Region variables are deliberately unmanaged — they carry
 * no credential, and clearing them would break unrelated tooling.
 *
 * Known gap: the Identity Center token cache (`~/.aws/sso/cache`) has no
 * override and stays machine-wide. Entries there are keyed by session, so
 * accounts never collide, but those tokens are not per-context.
 */
const aws: Adapter = {
  name: "aws",
  label: "AWS CLI",
  cli: "aws",
  managedEnv: [
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_LOGIN_CACHE_DIRECTORY",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_CREDENTIAL_EXPIRATION",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    "AWS_EC2_METADATA_DISABLED"
  ],
  deniedEnv: (root) => ({
    AWS_CONFIG_FILE: path.join(root, "aws", "config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(root, "aws", "credentials"),
    AWS_LOGIN_CACHE_DIRECTORY: path.join(root, "aws", "login-cache"),
    // Without this, a denied context on an EC2 host would fall through to the
    // instance role — exactly the machine default that denial exists to block.
    AWS_EC2_METADATA_DISABLED: "true"
  }),
  validateAccount: validateStateDirAccount,
  envFor: (a) => {
    const dir = expandPath(a.stateDir!);
    return {
      AWS_CONFIG_FILE: path.join(dir, "config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "credentials"),
      AWS_LOGIN_CACHE_DIRECTORY: path.join(dir, "login-cache")
    };
  },
  freshStateDir: (name) => path.join(stateRoot(), "aws", name),
  prepareStateDir(account) {
    if (account.system || !account.stateDir) return;
    // `aws login` writes into the cache directory but will not create it.
    ensureDir(path.join(expandPath(account.stateDir), "login-cache"));
  },
  loginCommand: (a) => (usesSso(a) ? ["aws", "sso", "login"] : ["aws", "login"]),
  identity: () => ({
    argv: ["aws", "sts", "get-caller-identity", "--output", "json"],
    parse(stdout, stderr, status) {
      if (status !== 0) return { ok: false, summary: firstLine(stderr) || `aws exited with status ${status}` };
      try {
        const caller = JSON.parse(stdout);
        if (!caller.Arn) return { ok: false, summary: "aws returned no caller ARN" };
        return { ok: true, summary: caller.Arn };
      } catch {
        return { ok: false, summary: "aws returned invalid JSON" };
      }
    }
  })
};

const azure: Adapter = {
  name: "azure",
  label: "Azure CLI",
  cli: "az",
  managedEnv: ["AZURE_CONFIG_DIR", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID"],
  deniedEnv: (root) => ({ AZURE_CONFIG_DIR: path.join(root, "azure") }),
  validateAccount: validateStateDirAccount,
  envFor: (a) => ({ AZURE_CONFIG_DIR: expandPath(a.stateDir!) }),
  freshStateDir: (name) => path.join(stateRoot(), "azure", name),
  loginCommand: () => ["az", "login"],
  identity: () => ({
    argv: ["az", "account", "show", "--output", "json"],
    parse(stdout, stderr, status) {
      if (status !== 0) return { ok: false, summary: firstLine(stderr) || `az exited with status ${status}` };
      try {
        const account = JSON.parse(stdout);
        const user = account.user?.name ?? "(unknown user)";
        const sub = account.name ?? "(unknown subscription)";
        const tenant = account.tenantId ? ` tenant ${account.tenantId}` : "";
        return { ok: true, summary: `${user} — ${sub}${tenant}` };
      } catch {
        return { ok: false, summary: "az returned invalid JSON" };
      }
    }
  })
};

const gcloud: Adapter = {
  name: "gcloud",
  label: "Google Cloud SDK",
  cli: "gcloud",
  managedEnv: ["CLOUDSDK_CONFIG", "CLOUDSDK_ACTIVE_CONFIG_NAME", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_ACCESS_TOKEN"],
  deniedEnv: (root) => ({ CLOUDSDK_CONFIG: path.join(root, "gcloud") }),
  validateAccount: validateStateDirAccount,
  envFor: (a) => ({ CLOUDSDK_CONFIG: expandPath(a.stateDir!) }),
  freshStateDir: (name) => path.join(stateRoot(), "gcloud", name),
  loginCommand: () => ["gcloud", "auth", "login"],
  identity: () => ({
    argv: ["gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
    parse(stdout, stderr, status) {
      if (status !== 0) return { ok: false, summary: firstLine(stderr) || `gcloud exited with status ${status}` };
      const account = stdout.trim();
      if (!account) return { ok: false, summary: "no active account (run login)" };
      return { ok: true, summary: account };
    }
  })
};

const github: Adapter = {
  name: "github",
  label: "GitHub CLI",
  cli: "gh",
  managedEnv: ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
  deniedEnv: (root) => ({ GH_CONFIG_DIR: path.join(root, "github") }),
  validateAccount: validateStateDirAccount,
  envFor: (a) => ({ GH_CONFIG_DIR: expandPath(a.stateDir!) }),
  freshStateDir: (name) => path.join(stateRoot(), "github", name),
  loginCommand: () => ["gh", "auth", "login"],
  identity: () => ({
    argv: ["gh", "auth", "status"],
    parse(stdout, stderr, status) {
      const text = `${stdout}\n${stderr}`;
      const match = text.match(/Logged in to (\S+) account (\S+)/);
      if (status === 0 && match) return { ok: true, summary: `${match[2]} @ ${match[1]}` };
      if (status === 0) return { ok: true, summary: firstLine(stdout) || "logged in" };
      return { ok: false, summary: firstLine(stderr) || firstLine(stdout) || `gh exited with status ${status}` };
    }
  })
};

const claude: Adapter = {
  name: "claude",
  label: "Claude Code",
  cli: "claude",
  managedEnv: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
  deniedEnv: (root) => ({ CLAUDE_CONFIG_DIR: path.join(root, "claude") }),
  validateAccount: validateStateDirAccount,
  envFor: (a) => ({ CLAUDE_CONFIG_DIR: expandPath(a.stateDir!) }),
  freshStateDir: (name) => path.join(stateRoot(), "claude", name),
  loginCommand: () => ["claude", "auth", "login"],
  identity: () => ({
    argv: ["claude", "auth", "status"],
    parse(stdout, stderr, status) {
      try {
        const parsed = JSON.parse(stdout.trim() || "{}");
        if (parsed.loggedIn === false) return { ok: false, summary: "not logged in" };
        if (parsed.loggedIn === true) {
          const details = [parsed.email, parsed.authMethod, parsed.subscriptionType].filter(Boolean).join(" / ");
          return { ok: true, summary: details || "logged in" };
        }
      } catch {
        // fall through to text handling
      }
      const message = firstLine(stdout) || firstLine(stderr) || `claude exited with status ${status}`;
      return { ok: status === 0, summary: message };
    }
  })
};

const codex: Adapter = {
  name: "codex",
  label: "Codex CLI",
  cli: "codex",
  managedEnv: ["CODEX_HOME", "OPENAI_API_KEY"],
  deniedEnv: (root) => ({ CODEX_HOME: path.join(root, "codex") }),
  validateAccount: validateStateDirAccount,
  envFor: (a) => ({ CODEX_HOME: expandPath(a.stateDir!) }),
  freshStateDir: (name) => path.join(stateRoot(), "codex", name),
  loginCommand: () => ["codex", "login"],
  identity: () => ({
    argv: ["codex", "login", "status"],
    parse(stdout, stderr, status) {
      const message = firstLine(stdout) || firstLine(stderr) || `codex exited with status ${status}`;
      return { ok: status === 0, summary: message };
    }
  })
};

const kubernetes: Adapter = {
  name: "kubernetes",
  label: "Kubernetes",
  cli: "kubectl",
  managedEnv: ["KUBECONFIG"],
  deniedEnv: (root) => ({ KUBECONFIG: path.join(root, "kubeconfig") }),
  validateAccount(account) {
    if (account.system) {
      return account.stateDir || account.kubeconfig ? "system accounts take no --path/--kubeconfig" : null;
    }
    if (!account.kubeconfig) return "missing 'kubeconfig' (path to a kubeconfig file, or set 'system: true')";
    return null;
  },
  envFor: (a) => ({ KUBECONFIG: expandPath(a.kubeconfig!) }),
  identity: () => ({
    argv: ["kubectl", "config", "current-context"],
    parse(stdout, stderr, status) {
      if (status !== 0) return { ok: false, summary: firstLine(stderr) || `kubectl exited with status ${status}` };
      return { ok: true, summary: `current-context: ${stdout.trim()}` };
    }
  })
};

export const adapters: Record<string, Adapter> = {
  aws,
  azure,
  gcloud,
  github,
  claude,
  codex,
  kubernetes
};

export function getAdapter(name: string): Adapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new CliError(`Unknown adapter: ${name}\nAvailable adapters: ${adapterNames().join(", ")}`);
  }
  return adapter;
}

export function adapterNames(): string[] {
  return Object.keys(adapters).sort();
}
