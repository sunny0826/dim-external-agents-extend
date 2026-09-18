# AGENTS.md

Guidance for AI agents working in this repository.

## Project

`dim-external-agents-extend` is a DimAgent plugin that shows the execution logs of external agents (Kimi / Cursor / Codex / Grok / OpenCode / ZCode) launched by dim. It has zero third-party dependencies, no build step, and runs on the Node runtime bundled with DimAgent.

## Environment: always use mise

- The toolchain is pinned in `mise.toml` (Node 24.18.0) — the single source of truth for the dev runtime.
- Run commands through mise, e.g. `mise exec -- node --test` and `mise exec -- node scripts/validate.js`.
- Do not introduce other runtime version sources (nvm, Homebrew node, global npm installs).

## Language policy (default: English)

- **README is bilingual; English is the default.** `README.md` is English; `README.zh-CN.md` is Chinese. Keep the language-switch links at the top of both files, and keep both versions in sync whenever you edit either one.
- **CHANGELOG.md is written in English.**
- **GitHub release notes are written in English.**
- **AGENTS.md is written in English.**
- UI text and code comments follow the existing convention of each file (the current sources are mostly Chinese) — do not mass-translate them.

## Versioning & release

- The version string lives in exactly two places and they must stay in sync:
  - `.codex-plugin/plugin.json` → `version`
  - `server/src/index.js` → `SERVER_INFO.version`
- `scripts/validate.js` enforces this along with other structure checks; CI runs it on every push / PR.
- Release steps: update both version strings → update `CHANGELOG.md` (English) → run tests and validation → commit → push an annotated tag `vX.Y.Z` → create a GitHub Release with English notes.

## CI

- `.github/workflows/ci.yml` runs on pushes to `main` and on pull requests: it installs the mise toolchain, runs `scripts/validate.js`, then the full test suite.
- Keep CI green; do not push changes that fail it.

## Conventions

- Zero third-party dependencies, no build step — do not add npm packages or bundlers.
- Tests: `mise exec -- node --test` (90+ tests, `node:test`).
- `.gitignore` covers local noise (`.DS_Store`, `node_modules/`, logs) — never commit ignored files.
- Local dev install: symlink the repo to `~/.agents/plugins/external-agents-extend`; restart DimAgent to pick up changes.
