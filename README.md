# agentctx

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

Built for the way work looks now: you don't just run cloud CLIs yourself — you launch an AI agent inside a project folder and *it* runs them. `csw run -- claude` hands the agent a complete, isolated identity bundle: the right Claude account, and the right Azure/GitHub/gcloud/kubectl credentials for every subprocess it spawns. One wrong inherited environment variable is the difference between deploying to your client's dev subscription and your other client's production — agentctx makes that class of accident structurally impossible.

## Install

```sh
npm install -g agentctx
```

Requires Node 20+ (if you use Claude Code or Codex, you already have it). macOS and Linux; zsh and bash hooks.

## 60-second start

```sh
csw init

# A fresh, isolated Azure login (launches the normal `az login` browser flow):
csw account add azure --name acme

# Reference logins you already have (nothing is copied or re-authenticated):
csw account add github --name work --path ~/.config/gh
csw account add claude --system            # your existing keychain-bound Claude Code login

# Compose accounts into a context, then bind it to a folder tree:
csw context add acme azure:acme github:work claude:default
csw bind acme --dir ~/clients/acme

# Auto-switch on cd — add once to ~/.zshrc (or `hook bash` for bash):
echo 'eval "$(csw hook zsh)"' >> ~/.zshrc

# Verify everything, including live "who am I" checks per provider:
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
| **Adapter** | `azure`, `claude` | Knows how one credential domain isolates state |
| **Account** | `azure:acme` | One provider identity, stored outside any repo |
| **Context** | `acme` | A composition: Azure ACME + GitHub work + Claude default |
| **Binding** | `~/clients/acme → acme` | A folder tree that selects a context |

Every command resolves the active context the same way:

```
--context flag → pinned shell (csw shell) → nearest folder binding → global default (csw use) → none
```

**Contexts are complete environments.** Before a context is applied, every managed variable of every adapter is cleared. An adapter you didn't include falls back to its own system default — never to whatever happened to be exported in your shell. A stray `GH_TOKEN` or `AZURE_CONFIG_DIR` from three terminals ago cannot leak into your client's context.

## Adapters

| Adapter | Isolation mechanism | Notes |
|---|---|---|
| `azure` | `AZURE_CONFIG_DIR` | Full isolation, per-account login state |
| `gcloud` | `CLOUDSDK_CONFIG` | Includes application-default credentials |
| `github` | `GH_CONFIG_DIR` | Also clears `GH_TOKEN`/`GITHUB_TOKEN` so they can't cross contexts |
| `claude` | `CLAUDE_CONFIG_DIR`, or `--system` | `--system` explicitly uses your default (macOS Keychain-bound) login |
| `codex` | `CODEX_HOME` | Full isolation |
| `kubernetes` | `KUBECONFIG` | References a kubeconfig file; also honored by helm, k9s, … |

Three ways to create an account:

- **Fresh** — `csw account add azure --name acme` creates isolated state and launches the provider's own login flow (browser, MFA, everything).
- **Reference** — `--path ~/.config/gh` points at login state you already have. Nothing is copied, moved, or re-authenticated.
- **System** — `csw account add claude --system` explicitly means "the machine's default login". Explicit, so a context never *silently* falls through to it.

## Where things live

```
~/.config/agentctx/config.json    # the context map: names, paths, bindings — no secrets
~/.local/state/agentctx/          # isolated provider state created by `account add`
```

agentctx never reads, writes, copies, or proxies credentials. It only decides **which** state directory each provider CLI sees, and lets the provider's own tooling do every login. Your repos contain nothing: bindings live in your home config, keyed by folder path.

`csw account remove` only edits config — it never deletes credential state, and tells you where the state lives so you can remove it yourself.

## Commands

```
csw init                                      create the config
csw account add <adapter> --name <n>          fresh isolated login
csw account add <adapter> --name <n> --path <dir>   reference existing state
csw account list | remove <id>
csw context add <name> <adapter>:<acct> ...   compose a context
csw context remove <name>
csw list                                      contexts, accounts, bindings
csw use <context>                             global default
csw bind <context> [--dir <dir>]              folder tree → context
csw unbind [--dir <dir>]
csw current [--explain]                       what's active, and why
csw run [--context <ctx>] -- <cmd> [args]     one command, fully resolved identity
csw shell [<context>] | csw shell --off       pin / unpin this shell
csw hook <zsh|bash>                           auto-switch hook
csw doctor [<context>]                        paths, CLIs, live identity checks
```

`csw doctor` is the trust anchor: it asks each provider CLI "who am I" inside each context and shows the actual account, subscription, and tenant.

## How it compares

- **direnv** switches env vars per folder, but you write the exports yourself, there's no identity model, no login flow, and no `doctor` to prove who you are.
- **aws-vault / gcloud configurations / kubectl contexts** each solve one provider. agentctx composes *across* providers — one context = the whole hat you're wearing.
- **1Password shell plugins** are excellent if you want a vault in the loop. agentctx is vault-agnostic and provider-native: your credentials stay exactly where `az login` and `gh auth login` put them.
- None of them treat **AI agents as identities**. That's the point here.

## Safety notes (v0.1, honest edition)

- The hook only reacts to `cd` in shells where you installed it; `csw run` needs no hook at all and is the recommended mode for agents and CI.
- `ANTHROPIC_API_KEY` is *not* currently managed (too many non-Claude tools use it). A strict mode that clears it per context is on the roadmap.
- Bindings are local to your machine (`~/.config/agentctx`). Committed, in-repo context manifests are deliberately absent until they can ship with a trust model — a cloned repo must never silently select your production identity.
- Windows: not yet. PowerShell hook and native-profile adapters (AWS) are next.

## Roadmap

AWS (native profiles) · Gemini CLI · Docker · Terraform/OpenTofu · GitLab · npm registry · `csw setup` detection wizard · strict mode · trusted in-repo manifests · Homebrew tap.

## License

MIT © Masoud Abdi
