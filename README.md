# credswitch

[![npm](https://img.shields.io/npm/v/credswitch)](https://www.npmjs.com/package/credswitch)
[![CI](https://github.com/itsmasabdi/credswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/itsmasabdi/credswitch/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/credswitch)](https://www.npmjs.com/package/credswitch)
[![license](https://img.shields.io/npm/l/credswitch)](./LICENSE)

**One identity context per project — for every CLI and AI agent.**

`cd ~/clients/acme` and your AWS CLI, Azure CLI, GitHub CLI, gcloud, kubectl, **Claude Code, and Codex** all switch to that client's accounts. Leave the folder and they switch back. Like a Python virtualenv, but for who you are.

```console
$ cd ~/clients/acme
$ az account show --query user.name -o tsv
you@acme-consulting.com

$ cd ~/personal/side-project
$ az account show --query user.name -o tsv
you@outlook.com
```

Built for the way work looks now: you don't just run cloud CLIs yourself — you launch an AI agent inside a project folder and *it* runs them. `csw run -- claude` hands the agent a complete, isolated identity bundle: the right Claude account, and the right AWS/Azure/GitHub/gcloud/kubectl credentials for every subprocess it spawns.

Contexts are **fail-closed**. A provider you didn't put in the context is *denied* — its CLI reports not-logged-in instead of silently acting as whoever your machine defaults to. Using the machine default is a decision you make explicitly, per context.

## Install

```sh
npm install -g credswitch
csw setup        # once: creates the config, adds the shell hook to your rc file
```

Requires Node 20+ (if you use Claude Code or Codex, you already have it). macOS and Linux; zsh and bash.

## The whole workflow

```sh
cd ~/clients/acme
csw login claude     # browser login → THIS folder now has its own Claude account
claude               # you're acme's identity here — and only here
```

That one `csw login` created an isolated account, ran the provider's real login,
verified and pinned who you are, named a context after the folder, and bound the
folder tree to it — effective at your next prompt, in the shell you're already in.
Add more providers the same way:

```sh
csw login azure      # az login, isolated to this folder
csw login github
csw login azure --global      # or: set your machine-wide default identity
```

Folders you didn't log in inside just use your global default. Nest folders and
the nearest binding wins. Share one identity across several folders by naming it:

```sh
cd ~/clients/acme-second-repo
csw local acme       # bind this folder to the existing 'acme' context
```

And to see or verify what's active:

```sh
csw current --explain    # what's active, why, and what's denied
csw doctor               # live "who am I" per provider + drift against pins
csw run -c acme -- az group list    # or be explicit, no hook needed
```

`current`, `list`, and `doctor` all take `--json`, so an agent can check which
identity it is holding without parsing prose — and `doctor --json` still exits
2 on drift, which makes it usable as a CI gate:

```console
$ csw doctor --json | jq '.contexts[].accounts[] | select(.identity.drift)'
```

## Under the hood

`csw login` and `csw local` drive four primitives you can also manage directly
(`csw account`, `csw context`, `csw bind` — see Plumbing below):

| Primitive | Example | What it is |
|---|---|---|
| **Adapter** | `azure`, `claude` | Knows one credential domain: its env channels, login, identity check |
| **Account** | `azure:acme` | One provider identity, stored outside any repo |
| **Context** | `acme` | A composition: Azure ACME + GitHub work + Claude default |
| **Binding** | `~/clients/acme → acme` | A folder tree that selects a context |

Every command — and the shell hook — resolves the active context through one resolver:

```
--context flag → pinned shell (csw shell) → nearest folder binding
→ inherited from parent process (CREDSWITCH_CONTEXT) → global default (csw use) → none
```

Applying a context does three things, in order:

1. **Clears every managed credential channel of every adapter** — selectors, token variables, host overrides. A stray `GH_TOKEN`, `ANTHROPIC_API_KEY`, or `AZURE_CONFIG_DIR` exported three terminals ago cannot leak in.
2. **Denies every adapter the context omits.** Denied selectors point into a read-only directory, so the provider CLI sees empty state and cannot write any — an accidental `az login` inside a denied context fails instead of quietly creating a shared fallback identity.
3. **Applies the context's accounts.** A `--system` account is the explicit way to say "this context uses the machine's default login" for that one provider.

`inherited` is what makes agents composable: `csw run --context acme -- claude` sets acme as the *floor* for everything the agent spawns — whether it calls `csw run -- az ...` directly, or shells out to a subprocess that sources your rc file and runs the hook. Anywhere on disk, it stays acme unless a folder binding says otherwise. That exception matters: an agent that wanders into another client's bound folder picks up *that* client's identity rather than carrying acme's credentials into it.

## Adapters

| Adapter | Selector | Also managed (cleared) |
|---|---|---|
| `aws` | `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_LOGIN_CACHE_DIRECTORY` | `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_ROLE_ARN`, container/IMDS credential sources |
| `azure` | `AZURE_CONFIG_DIR` | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| `gcloud` | `CLOUDSDK_CONFIG` | `CLOUDSDK_ACTIVE_CONFIG_NAME`, `GOOGLE_APPLICATION_CREDENTIALS` |
| `github` | `GH_CONFIG_DIR` | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST` |
| `claude` | `CLAUDE_CONFIG_DIR` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` |
| `codex` | `CODEX_HOME` | `OPENAI_API_KEY` |
| `kubernetes` | `KUBECONFIG` | — (also honored by helm, k9s, …) |

AWS is the one provider with no single config-directory variable, so the `aws`
adapter redirects all three writable channels the CLI owns: both profile files
and the `aws login` credential cache. `csw login aws` picks the right re-auth
flow from the account's own config — `aws sso login` for an IAM Identity Center
profile, `aws login` otherwise (including a brand-new state directory). Denial
also sets `AWS_EC2_METADATA_DISABLED`, because on an EC2 host instance metadata
is itself a credential source that would otherwise be a silent fallback.

Two deliberate limits. `AWS_REGION` / `AWS_DEFAULT_REGION` are **not** managed —
they carry no credential and clearing them would break unrelated tooling. And
the Identity Center token cache (`~/.aws/sso/cache`) has no environment
override, so it stays machine-wide; entries are keyed by session so accounts
never collide, but those tokens are not isolated per context.

Codex profiles also persist an absolute source path for the app-owned
`openai-bundled` marketplace. If it still points at another profile (commonly
`~/.codex/.tmp`), credswitch atomically rebases it under the account's own
`CODEX_HOME`, keeping bundled Browser/Chrome plugins aligned with ChatGPT app
updates. `csw setup`, `csw doctor`, and `csw login` do this; context switching
deliberately does not — the hook path stays side-effect free, because a failure
there would read as "resolution failed" and deny every provider. Only that
marketplace source line is changed; credentials, other marketplaces, plugin
choices, and caches are left alone. Ambiguous or non-local marketplace
configurations are not rewritten, and both those and failed rewrites are
flagged by `csw doctor`.

Verified on macOS: a redirected `CLAUDE_CONFIG_DIR` fully isolates Claude Code from the Keychain-bound default login (`authMethod: none` when denied).

Three ways to create an account:

- **Fresh** — `csw account add azure --name acme` creates isolated state and launches the provider's own login flow (browser, MFA, everything). If the login fails or is cancelled, *nothing is saved*.
- **Reference** — `--path ~/.config/gh` points at login state you already have. Nothing is copied, moved, or re-authenticated.
- **System** — `--system` explicitly means "the machine's default login" for that provider in that context.

### Pinned identities

When an account is added (or `csw account login` succeeds), the verified identity — user, subscription, tenant — is **pinned**. From then on, `csw doctor` fails loudly if the state answers as anyone else:

```
!  azure:acme identity drift:
     pinned: you@acme-consulting.com — ACME-PROD tenant aaaa1111…
     actual: you@outlook.com — Personal subscription tenant bbbb2222…
     accept the new identity with: csw account pin azure:acme
```

That catches the classic consultant accident — an `az login` run in the wrong terminal — before it becomes a deployment into the wrong tenant.

## Where things live

```
~/.config/credswitch/config.json    # the context map: names, paths, bindings, pins — no secrets
~/.local/state/credswitch/          # isolated provider state created by `account add`
~/.local/state/credswitch/denied/   # read-only; where denied providers point
```

credswitch never reads, copies, or proxies credentials. It only decides **which** state each provider CLI sees, and lets the provider's own tooling do every login. It writes into provider state in exactly one place: the `openai-bundled` marketplace source line described above, and only from `setup`, `doctor`, and `login`. Your repos contain nothing: bindings live in your home config, keyed by folder path. Config mutations take a lock, so concurrent agents can't lose each other's updates.

`csw account remove` only edits config — it never deletes credential state, and tells you where the state lives so you can remove it yourself.

## Commands

Everyday:

```
csw setup                                     one-time: config + shell hook
csw login <adapter> [--as <n>] [--global]     give THIS folder its own identity
csw local [<context>]                         bind this folder to a named context (blank: show)
csw current [--explain] [--json]              what's active, why, and what's denied
csw run [--context <ctx>] -- <cmd> [args]     one command, fully resolved identity
csw list [--json]                             contexts, accounts, bindings
csw doctor [<context>] [--json]               paths, CLIs, live identities, drift
```

Plumbing (the porcelain drives these; use them for reference imports, kubeconfigs, renames):

```
csw init                                      create the config only
csw account add <adapter> --name <n> [--path <dir>] [--kubeconfig <f>] [--system] [--context <c>] [--no-login]
csw account login <id> | pin <id> | list | remove <id>
csw context add|set <name> <adapter>:<acct> ... | remove <name>
csw use <context>                             global default
csw bind <context> [--dir <dir>] | unbind [--dir <dir>]
csw shell [<context>] | csw shell --off       pin / unpin this shell
csw hook <zsh|bash>                           print the auto-switch hook
```

## The hook, honestly

The zsh/bash hook runs before each prompt (like direnv) and is resolver-backed: it cannot disagree with `csw current`. It applies your default context in shells outside any bound tree, switches on entering one (nearest binding wins, symlinks canonicalized), switches back on leaving — and because it's per-prompt with a config generation stamp, `csw login`, `csw local`, and account swaps take effect at the *next prompt in every open shell*, no cd required. The pure-shell fast path only invokes `csw` when something changed, so prompts stay fast. If resolution fails—or the `csw` executable is unavailable—the installed bootstrap points every provider at the denied state root, clears every managed token variable, and prints a warning: fail closed, never stale. Shells pinned with `csw shell` are left alone.

## How it compares

- **direnv** switches env vars per folder, but you write the exports yourself, there's no identity model, no login flow, and no `doctor` to prove who you are.
- **aws-vault / gcloud configurations / kubectl contexts** each solve one provider. credswitch composes *across* providers — one context = the whole hat you're wearing.
- **1Password shell plugins** are excellent if you want a vault in the loop. credswitch is vault-agnostic and provider-native: your credentials stay exactly where `az login` and `gh auth login` put them.
- None of them treat **AI agents as identities**. That's the point here.

## Safety notes (v0.2, honest edition)

- Denied providers fail with provider-specific messages: `gh` and `kubectl` say not-logged-in cleanly; `gcloud` and `codex` complain about the unwritable/missing denied directory. Blunt, but closed — add the account (or a `--system` account) to the context to enable a provider.
- The deny/clear guarantees apply *inside contexts* (`csw run`, pinned shells, hooked shells). A shell with no hook and no pin is whatever your machine is.
- Codex's identity probe proves login state but not *which* account — its pin is a weak fingerprint. Azure, gcloud, GitHub, and Claude pins carry real identities.
- A folder only ever *gains* an identity when you run `csw login`/`csw local` inside it. Bindings are local to your machine (`~/.config/credswitch`); committed, in-repo context manifests are deliberately absent until they can ship with a trust model — a cloned repo must never silently select your production identity.
- Windows: not yet. PowerShell hook and native-profile adapters (AWS) are next.

## Roadmap

AWS (native profiles) · Gemini CLI · Docker · Terraform/OpenTofu · GitLab · npm registry · `csw setup` detection wizard · per-context env passthrough · trusted in-repo manifests · Homebrew tap.

## License

MIT © Masoud Abdi
