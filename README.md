# clawctl

`clawctl` is a runtime manager for claws.

It installs versioned claw implementations into a private shared root, keeps one active claw selection, renders isolated runtime config from shared credentials, and manages a local background runtime for supported claws.

The product shape is closer to `mise` or `nvm` than to a benchmark harness.

## Current Status

Implemented today:

- Bun + Effect CLI in [`packages/cli`](packages/cli)
- shared root under `~/.clawctl` by default, with env overrides
- backend-aware install and runtime plumbing for both `local` and `docker`
- shared config plus isolated per-runtime state
- active shims under `~/.clawctl/bin/`
- install, list, versions, use, current, doctor, cleanup, init, status, ping, chat, stop, uninstall, and config flows

Current limits:

- supported host platform: `darwin-arm64`
- `source-build` is still modeled but not implemented

## Supported Claws

Fully supported:

- Tier 1: `nullclaw`, `picoclaw`, `zeroclaw` with local and Docker backends
- Tier 2: `openclaw`, `nanobot` with local and Docker backends

Registered with limits:

- `hermes`
  - bootstrap-backed adapter with local and Docker backends
  - supports managed `use`, `status`, `stop`, `chat`, and `ping`

## Monorepo Layout

- [`packages/cli`](packages/cli) — the live `clawctl` command-line app
- [`packages/skill`](packages/skill) — skill package for agents using `clawctl`
- [`packages/website`](packages/website) — Astro marketing site
- [`SPEC.md`](SPEC.md) — implementation-aligned product and architecture spec

If you want the operator guide for the CLI, start with [`packages/cli/README.md`](packages/cli/README.md).

## Quick Start

Install dependencies:

```bash
bun install
```

Run the CLI from the repo root:

```bash
bun run cli --help
```

Common examples:

```bash
export PATH="$HOME/.clawctl/bin:$PATH"
bun run cli list
bun run cli versions openclaw
bun run cli config set CLAW_API_KEY sk-...
bun run cli config set TELEGRAM_BOT_TOKEN 123456:ABCDEF...
bun run cli install openclaw
bun run cli use openclaw
bun run cli chat "Summarize the current workspace."
bun run cli stop
```

## Development

Run the CLI:

```bash
bun run cli --help
```

Build the CLI binary:

```bash
bun run cli:build
```

Run the website:

```bash
bun run web
```

Lint, typecheck, and verify the workspace:

```bash
bun run lint
```

Run the CLI package tests directly:

```bash
bun run --cwd packages/cli test
```

## Shared Config

`clawctl` currently shares these keys across claws:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_ALLOWED_FROM`

Current live adapters use:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`
- adapter-specific Telegram settings where supported

Shared config lives at `~/.clawctl/config/shared.env`. Each runtime still gets its own isolated `HOME`, config files, workspace, and state directory.

When you run `clawctl use ...`, it also updates active shims under `~/.clawctl/bin/`:

- `claw`
- `<active-implementation>`

Add that directory to `PATH` if you want the active claw CLI to resolve natively.

You can also let `clawctl` append the PATH setup for supported shells:

```bash
bun run cli init
```

## Documentation

- Project spec: [`SPEC.md`](SPEC.md)
- CLI usage guide: [`packages/cli/README.md`](packages/cli/README.md)
- Agent skill: [`packages/skill/clawctl/SKILL.md`](packages/skill/clawctl/SKILL.md)
