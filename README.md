# clawctl

> Versioned runtime manager for claws.

`clawctl` is a standalone monorepo for the next generation of the claw manager described in [SPEC.md](SPEC.md).

The workspace is organized as:

- [`packages/cli`](packages/cli) — Effect-based command-line application
- [`packages/skill`](packages/skill) — skill package for AI agents using `clawctl`
- [`packages/website`](packages/website) — Astro landing page

## Development

Install dependencies:

```bash
bun install
```

Run the CLI:

```bash
bun run cli --help
```

Run the website:

```bash
bun run web
```

Lint and typecheck:

```bash
bun run lint
```
