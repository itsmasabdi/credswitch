# Changelog

## 0.2.1 — 2026-07-10

Docs-only: README badges, sanitized examples, SECURITY.md and CHANGELOG
added to the repo. No code changes.

## 0.2.0 — 2026-07-10

First public release, published as `credswitch`.

- **Fail-closed contexts**: adapters a context omits are *denied* — their
  selectors point into a read-only denied root, so their CLIs report
  not-logged-in and can never persist credentials there. `--system` is the
  explicit machine-default opt-in, available on every adapter.
- **Full credential-channel inventory**: `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `GH_TOKEN`/`GITHUB_TOKEN`/`GH_HOST`, and `AZURE_CLIENT_*` are managed
  (cleared) alongside the config-dir selectors.
- **Resolver-backed shell hook** (`csw env --cwd`): applies the default
  context outside bound trees, canonicalizes `$PWD`, detects rebinds, and
  clears loudly on failure instead of retaining stale credentials.
- **Identity pinning**: `account add`/`account login` pin the verified
  identity; `csw doctor` fails on drift; `csw account pin` accepts changes
  deliberately.
- **Transactional onboarding**: login + verification before anything is
  saved; a failed or cancelled login saves nothing and removes its fresh
  state dir; account names validated before any filesystem use; referenced
  paths stored canonically; non-empty fresh dirs refused.
- **Concurrency safety**: config mutations take a lock; the hook's bindings
  list is written before the config so crash skew fails safe.
- Resolution precedence gains an `inherited` level (`CREDSWITCH_CONTEXT`)
  so nested agent runs keep their parent's context.
- Commands: `account login`, `account pin`, `context set`; real signal exit
  codes from `csw run`.

Adapters: azure, gcloud, github, claude, codex, kubernetes.

## 0.1.0 — 2026-07-10 (unpublished; git history only)

Initial four-primitive core (adapters / accounts / contexts / bindings),
single resolver, env clearing, zsh/bash hooks, fake-provider test suite.
