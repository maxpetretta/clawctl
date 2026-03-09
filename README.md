# clawctl

`clawctl` is a local runtime manager for claws.

It installs versioned claw implementations into a private shared root, keeps one active claw selection, renders isolated runtime config from shared credentials, and manages a local background runtime for supported claws.

The product shape is closer to `mise` or `nvm` than to a benchmark harness.

## Current Status

Implemented today:

- Bun + Effect CLI in [`packages/cli`](packages/cli)
- local backend only
- shared root under `~/.clawctl` by default
- shared config plus isolated per-runtime state
- install, list, versions, use, current, doctor, cleanup, status, ping, chat, uninstall, and config flows

Current limits:

- supported host platform: `darwin-arm64`
- `docker` is modeled but not implemented yet
- Telegram keys exist in shared config but are not wired into live adapters yet
- `piclaw` and `ironclaw` are not fully activatable yet

## Supported Claws

Fully supported:

- Tier 1: `nullclaw`, `picoclaw`, `zeroclaw`
- Tier 2: `openclaw`, `nanobot`

Registered with limits:

- `nanoclaw`
  - bootstrap-backed native daemon supervision works for `install`, `use`, `status`, and `stop`
  - `chat` and `ping` are not available because upstream does not expose a stable local loopback or host-side chat transport
- `bitclaw`
  - bootstrap-backed native daemon supervision works for `install`, `use`, `status`, `stop`, `chat`, and `ping`
- `ironclaw`
  - release-backed install metadata works
  - not activatable through the current managed runtime flow
- `piclaw`
  - Docker-first metadata only
  - `versions` and `doctor` work
  - Docker execution is not implemented

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
bun run cli list
bun run cli versions openclaw
bun run cli config set CLAW_API_KEY sk-...
bun run cli install openclaw
bun run cli use openclaw
bun run cli chat "Summarize the current workspace."
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

In practice, the current local adapters mainly use:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`

Shared config lives at `~/.clawctl/config/shared.env`. Each runtime still gets its own isolated `HOME`, config files, workspace, and state directory.

## Documentation

- Project spec: [`SPEC.md`](SPEC.md)
- CLI usage guide: [`packages/cli/README.md`](packages/cli/README.md)
- Agent skill: [`packages/skill/clawctl/SKILL.md`](packages/skill/clawctl/SKILL.md)
