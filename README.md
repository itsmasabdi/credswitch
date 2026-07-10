# credswitch

**One identity context per project — for every CLI and AI agent.**

`cd ~/clients/acme` and your Azure CLI, GitHub CLI, gcloud, kubectl, **Claude Code, and Codex** all switch to that client's accounts. Leave the folder and they switch back. Like a Python virtualenv, but for who you are.

```console
$ cd ~/clients/acme
$ az account show --query user.name -o tsv
you@acme-consulting.com

$ cd ~/personal/side-project
$ az account show --query user.name -o tsv
you@outlook.com
```

Built for the way work looks now: you don't just run cloud CLIs yourself — you launch an AI agent inside a project folder and *it* runs them. `csw run -- claude` hands the agent a complete, isolated identity bundle: the right Claude account, and the right Azure/GitHub/gcloud/kubectl credentials for every subprocess it spawns.

Contexts are **fail-closed**. A provider you didn't put in the context is *denied* — its CLI reports not-logged-in instead of silently acting as whoever your machine defaults to. Using the machine default is a decision you make explicitly, per context.

## Install

```sh
npm install -g credswitch
```

Requires Node 20+ (if you use Claude Code or Codex, you already have it). macOS and Linux; zsh and bash hooks.

## 60-second start

```sh
csw init

# A fresh, isolated Azure login (launches the normal `az login` browser flow):
csw account add azure --name acme

# Reference logins you already have (nothing is copied or re-authenticated):
csw account add github --name work --path ~/.config/gh
csw account add claude --system            # explicitly: the machine's default Claude login

# Compose accounts into a context, then bind it to a folder tree:
csw context add acme azure:acme github:work claude:default
csw bind acme --dir ~/clients/acme

# Auto-switch on cd — add once to ~/.zshrc (or `hook bash` for bash):
echo 'eval "$(csw hook zsh)"' >> ~/.zshrc

# Verify everything: paths, live "who am I" checks, drift against pinned identities:
csw doctor
```

Or skip the hook entirely and be explicit:

```sh
csw run --context acme -- az group list
csw run --context acme -- claude        # agent + all its subprocesses get acme's identity
eval "$(csw shell acme)"                # pin the current shell to acme
```

## The model

Four primitives:

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

`inherited` is what makes agents composable: `csw run --context acme -- claude` exports `CREDSWITCH_CONTEXT=acme`, so when the agent itself calls `csw run -- az ...` anywhere on disk, it stays acme unless a folder binding says otherwise.

## Adapters

| Adapter | Selector | Also managed (cleared) |
|---|---|---|
| `azure` | `AZURE_CONFIG_DIR` | `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| `gcloud` | `CLOUDSDK_CONFIG` | `CLOUDSDK_ACTIVE_CONFIG_NAME`, `GOOGLE_APPLICATION_CREDENTIALS` |
| `github` | `GH_CONFIG_DIR` | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST` |
| `claude` | `CLAUDE_CONFIG_DIR` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` |
| `codex` | `CODEX_HOME` | `OPENAI_API_KEY` |
| `kubernetes` | `KUBECONFIG` | — (also honored by helm, k9s, …) |

Verified on macOS: a redirected `CLAUDE_CONFIG_DIR` fully isolates Claude Code from the Keychain-bound default login (`authMethod: none` when denied).

Three ways to create an account:

- **Fresh** — `csw account add azure --name acme` creates isolated state and launches the provider's own login flow (browser, MFA, everything). If the login fails or is cancelled, *nothing is saved*.
- **Reference** — `--path ~/.config/gh` points at login state you already have. Nothing is copied, moved, or re-authenticated.
- **System** — `--system` explicitly means "the machine's default login" for that provider in that context.

### Pinned identities

When an account is added (or `csw account login` succeeds), the verified identity — user, subscription, tenant — is **pinned**. From then on, `csw doctor` fails loudly if the state answers as anyone else:

```
!  azure:tfe identity drift:
     pinned: mabdi@client-a.com — CLIENT-A-PROD tenant 080a8ef5…
     actual: you@personal.com — Personal subscription tenant 62a58fb7…
     accept the new identity with: csw account pin azure:tfe
```

That catches the classic consultant accident — an `az login` run in the wrong terminal — before it becomes a deployment into the wrong tenant.

## Where things live

```
~/.config/credswitch/config.json    # the context map: names, paths, bindings, pins — no secrets
~/.local/state/credswitch/          # isolated provider state created by `account add`
~/.local/state/credswitch/denied/   # read-only; where denied providers point
```

credswitch never reads, writes, copies, or proxies credentials. It only decides **which** state each provider CLI sees, and lets the provider's own tooling do every login. Your repos contain nothing: bindings live in your home config, keyed by folder path. Config mutations take a lock, so concurrent agents can't lose each other's updates.

`csw account remove` only edits config — it never deletes credential state, and tells you where the state lives so you can remove it yourself.

## Commands

```
csw init                                      create the config
csw account add <adapter> --name <n>          fresh isolated login (transactional)
csw account add <adapter> --name <n> --path <dir>   reference existing state
csw account add <adapter> --system            explicit machine default
csw account login <adapter>:<name>            (re)run the provider's login
csw account pin <adapter>:<name>              accept the current identity as the pin
csw account list | remove <id>
csw context add <name> <adapter>:<acct> ...   compose a context
csw context set <name> <adapter>:<acct> ...   replace a context's accounts
csw context remove <name>
csw list                                      contexts, accounts, bindings
csw use <context>                             global default
csw bind <context> [--dir <dir>]              folder tree → context
csw unbind [--dir <dir>]
csw current [--explain]                       what's active, why, and what's denied
csw run [--context <ctx>] -- <cmd> [args]     one command, fully resolved identity
csw shell [<context>] | csw shell --off       pin / unpin this shell
csw hook <zsh|bash>                           auto-switch hook
csw doctor [<context>]                        paths, CLIs, live identities, drift
```

## The hook, honestly

The zsh/bash hook is resolver-backed: it cannot disagree with `csw current`. It applies your default context in shells outside any bound tree, switches on entering one (nearest binding wins, symlinks canonicalized), and switches back on leaving. The pure-shell fast path only invokes `csw` on transitions, so `cd` stays fast. If resolution ever *fails*, the hook clears every managed variable and prints a warning — fail closed, never stale. Shells pinned with `csw shell` are left alone.

## How it compares

- **direnv** switches env vars per folder, but you write the exports yourself, there's no identity model, no login flow, and no `doctor` to prove who you are.
- **aws-vault / gcloud configurations / kubectl contexts** each solve one provider. credswitch composes *across* providers — one context = the whole hat you're wearing.
- **1Password shell plugins** are excellent if you want a vault in the loop. credswitch is vault-agnostic and provider-native: your credentials stay exactly where `az login` and `gh auth login` put them.
- None of them treat **AI agents as identities**. That's the point here.

## Safety notes (v0.2, honest edition)

- Denied providers fail with provider-specific messages: `gh` and `kubectl` say not-logged-in cleanly; `gcloud` and `codex` complain about the unwritable/missing denied directory. Blunt, but closed — add the account (or a `--system` account) to the context to enable a provider.
- The deny/clear guarantees apply *inside contexts* (`csw run`, pinned shells, hooked shells). A shell with no hook and no pin is whatever your machine is.
- Codex's identity probe proves login state but not *which* account — its pin is a weak fingerprint. Azure, gcloud, GitHub, and Claude pins carry real identities.
- Bindings are local to your machine (`~/.config/credswitch`). Committed, in-repo context manifests are deliberately absent until they can ship with a trust model — a cloned repo must never silently select your production identity.
- Windows: not yet. PowerShell hook and native-profile adapters (AWS) are next.

## Roadmap

AWS (native profiles) · Gemini CLI · Docker · Terraform/OpenTofu · GitLab · npm registry · `csw setup` detection wizard · per-context env passthrough · trusted in-repo manifests · Homebrew tap.

## License

MIT © Masoud Abdi
