---
name: clawctl
description: Use when managing local claw installs, switching the active claw, configuring shared claw credentials, listing available versions, or sending direct ping/chat commands through clawctl.
---

# clawctl

Use this skill when the task is about operating `clawctl` itself:

- installing a claw implementation or version
- listing installed or remote versions
- switching the active claw
- reading or updating shared config
- running `doctor`, `status`, `cleanup`, or `current`
- sending `ping` or `chat` through a supported managed runtime

Do not use this skill for generic coding tasks outside the `clawctl` workflow.

## What clawctl Is

`clawctl` is a local runtime manager for claws.

It:

- installs claws into a private versioned store under `~/.clawctl`
- keeps one active claw selection at a time
- renders isolated runtime config from shared credentials
- starts a clawctl-managed local runtime for supported claws

Current implementation limits:

- host platform: `darwin-arm64`
- backend: `local` only
- `docker` is parsed in the CLI but not implemented
- Telegram keys exist in shared config but are not wired into live adapters yet
- `ironclaw` is still install-only

## Claws Available

Fully supported today:

- Tier 1: `nullclaw`, `picoclaw`, `zeroclaw`
- Tier 2: `openclaw`, `nanobot`

Registered with limits:

- `nanoclaw`
  - bootstrap-backed native daemon supervision works for `install`, `use`, `status`, and `stop`
  - `chat` and `ping` are not implemented
- `bitclaw`
  - bootstrap-backed native daemon supervision works for `install`, `use`, `status`, and `stop`
  - `chat` and `ping` are not implemented
- `ironclaw`
  - release-backed install metadata works
  - not activatable through the current managed runtime flow
- `piclaw`
  - Docker-first metadata only
  - `versions` and `doctor` work
  - Docker execution is not implemented

Practical rule:

- Prefer `openclaw`, `nanobot`, `nullclaw`, `picoclaw`, or `zeroclaw` for real `use`, `chat`, and `ping` flows.

## Shared Credentials

`clawctl` shares these config keys across claws:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`

Current local adapters mainly require:

- `CLAW_API_KEY`
- `CLAW_BASE_URL`
- `CLAW_MODEL`

Read or write them with:

```bash
clawctl config get CLAW_MODEL
clawctl config set CLAW_API_KEY sk-...
clawctl config set CLAW_BASE_URL https://openrouter.ai/api/v1
clawctl config set CLAW_MODEL moonshotai/kimi-k2.5
```

Important behavior:

- shared credentials live in `~/.clawctl/config/shared.env`
- each runtime still gets isolated `HOME`, config files, state, and workspace
- `clawctl` installs do not intentionally reuse the user’s normal claw runtime state

## Common Patterns

### Inspect what exists

```bash
clawctl list
clawctl list --installed
clawctl versions openclaw
```

Use `versions` before `install` when the user asks for a specific upstream version.

### Install a claw

Latest:

```bash
clawctl install openclaw
```

Pinned:

```bash
clawctl install openclaw@2026.3.7
clawctl install picoclaw@v0.2.0
```

Notes:

- installs are versioned and private under `~/.clawctl/installs/local/<implementation>/<version>/`
- `openclaw` installs into a private npm prefix managed by `clawctl`
- `nanobot` installs into a private `uv tool` directory managed by `clawctl`

### Switch the active claw

```bash
clawctl use openclaw
clawctl use openclaw@2026.3.7
clawctl current
```

Behavior:

- `use` auto-installs the target if it is missing
- only one claw is active at a time
- `use` stops the previous managed runtime, starts the selected one, and then updates `current.json`

### Send a quick message

Use the active claw:

```bash
clawctl chat "Summarize the current workspace."
clawctl ping
```

Target a specific installed version directly:

```bash
clawctl chat "Reply in one sentence." openclaw@2026.3.7
clawctl ping openclaw
```

Behavior:

- `chat` and `ping` auto-activate the selected target before running
- if no target is provided, they use the current active claw
- supported claws run behind a clawctl-managed local background runtime
- unsupported claws should fail clearly instead of being forced into `chat`

### Diagnose or clean up

```bash
clawctl doctor
clawctl doctor openclaw
clawctl status
clawctl status openclaw
clawctl cleanup
clawctl cleanup openclaw
```

Use these when:

- installs look broken
- config is missing
- a current selection is stale
- partial installs or orphaned runtime directories need cleanup

### Remove installs

```bash
clawctl uninstall openclaw@2026.3.7
clawctl uninstall --all openclaw
```

## Agent Guidance

When helping with `clawctl`:

- Prefer the active claw when the user does not specify a target.
- Use `clawctl versions <implementation>` before assuming a version exists upstream.
- Use `clawctl doctor` before guessing why an install or runtime path is broken.
- Treat `docker` as not implemented today.
- Treat `ironclaw` and `piclaw` as limited.
- Treat `nanoclaw` and `bitclaw` as startable but not messageable through `clawctl`.
- Do not claim Telegram transport is working through `clawctl` yet.
- `stop` is real for the current managed local backend.

If the task is about implementation details or behavior, inspect the live CLI package:

- `packages/cli/README.md`
- `packages/cli/src/index.ts`
- `packages/cli/src/service.ts`
- `packages/cli/src/adapter/registry.ts`

## Fast Reference

```bash
clawctl list
clawctl list --installed
clawctl versions <implementation>
clawctl install <implementation>[@version]
clawctl use <implementation>[@version]
clawctl current
clawctl doctor [<implementation>]
clawctl status [<implementation>]
clawctl ping [<implementation>]
clawctl chat <message> [<implementation>]
clawctl cleanup [<implementation>]
clawctl uninstall [--all] <implementation>[@version]
clawctl config get <key>
clawctl config set <key> <value>
```
