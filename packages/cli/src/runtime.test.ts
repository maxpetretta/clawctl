import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Option, Redacted } from "effect"

import type { InstallRecord } from "./adapter/types.ts"
import { userError } from "./errors.ts"
import { ClawctlPathsService } from "./paths-service.ts"
import { ClawctlRuntimeService } from "./runtime-service.ts"
import { sharedConfigToEntries } from "./shared-config.ts"
import { ClawctlStoreService } from "./store-service.ts"
import { makeRuntimeTestLayer, runWithLayer } from "./test-layer.ts"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-runtime-"))
  tempRoots.push(root)
  return root
}

async function writeExecutable(destination: string, source: string) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, source, "utf8")
  await chmod(destination, 0o755)
}

function installRecord(root: string): InstallRecord {
  return {
    implementation: "openclaw",
    requestedVersion: "2026.3.7",
    resolvedVersion: "2026.3.7",
    backend: "local",
    installStrategy: "npm-package",
    installRoot: join(root, "installs", "local", "openclaw", "2026.3.7"),
    entrypointCommand: [join(root, "bin", "openclaw")],
    platform: { os: "darwin", arch: "arm64" },
    sourceReference: "openclaw",
    verificationSummary: "registry-managed",
    installedAt: "2026-03-09T00:00:00.000Z",
    supportTier: "tier2",
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("runtime service", () => {
  test("ensureActiveChatTarget uses the current selection", async () => {
    const root = await createRoot()
    const record = installRecord(root)

    const resolved = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        const runtime = yield* ClawctlRuntimeService
        yield* store.writeInstallRecord(record)
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        yield* store.writeCurrentSelection({
          implementation: record.implementation,
          version: record.resolvedVersion,
          backend: record.backend,
        })
        return yield* runtime.ensureActiveChatTarget(Option.none(), "chat")
      }),
      makeRuntimeTestLayer(root),
    )

    expect(resolved.resolvedVersion).toBe("2026.3.7")
  })

  test("fails without a target or current selection", async () => {
    const root = await createRoot()

    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const runtime = yield* ClawctlRuntimeService
          return yield* runtime.ensureActiveChatTarget(Option.none(), "chat")
        }),
        makeRuntimeTestLayer(root),
      ),
    ).rejects.toThrow("no active claw selected")
  })

  test("rejects unsupported capabilities", async () => {
    const root = await createRoot()
    const record: InstallRecord = {
      ...installRecord(root),
      implementation: "nanoclaw",
      installStrategy: "repo-bootstrap",
      installRoot: join(root, "installs", "local", "nanoclaw", "main"),
      entrypointCommand: [],
      requestedVersion: "main",
      resolvedVersion: "main",
      supportTier: "tier3",
    }

    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const store = yield* ClawctlStoreService
          const runtime = yield* ClawctlRuntimeService
          yield* store.writeInstallRecord(record)
          return yield* runtime.ensureActiveChatTarget(Option.some("nanoclaw"), "chat")
        }),
        makeRuntimeTestLayer(root),
      ),
    ).rejects.toThrow("implementation does not support chat: nanoclaw")
  })

  test("activateSelection writes rendered config and current state", async () => {
    const root = await createRoot()
    const record = installRecord(root)

    const activated = await runWithLayer(
      Effect.gen(function* () {
        const paths = yield* ClawctlPathsService
        const store = yield* ClawctlStoreService
        const runtime = yield* ClawctlRuntimeService
        yield* store.writeInstallRecord(record)
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        const activatedRecord = yield* runtime.activateSelection({
          implementation: "openclaw",
          version: "2026.3.7",
        })
        const current = yield* store.readCurrentSelection
        const configFile = join(paths.runtimeRoot("openclaw", "2026.3.7"), "home", ".openclaw", "openclaw.json")
        return {
          activatedRecord,
          configText: yield* Effect.tryPromise({
            try: () => Bun.file(configFile).text(),
            catch: (cause) => userError("runtime.test", String(cause)),
          }),
          current,
        }
      }),
      makeRuntimeTestLayer(root),
    )

    expect(activated.activatedRecord.resolvedVersion).toBe("2026.3.7")
    expect(activated.current).toEqual({
      implementation: "openclaw",
      version: "2026.3.7",
      backend: "local",
    })
    expect(activated.configText).toContain("openai-completions")
  })

  test("runChat renders config and normalizes output", async () => {
    const root = await createRoot()
    const record = installRecord(root)
    await writeExecutable(
      record.entrypointCommand[0] ?? join(root, "bin", "openclaw"),
      `#!/bin/sh
message=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ]; then
    message="$arg"
  fi
  prev="$arg"
done
printf '{"response":{"text":"reply:%s"}}\n' "$message"
`,
    )

    const output = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        const runtime = yield* ClawctlRuntimeService
        yield* store.writeInstallRecord(record)
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        return yield* runtime.runChat(record, "hello-runtime")
      }),
      makeRuntimeTestLayer(root),
    )

    expect(output).toBe("reply:hello-runtime")
  })

  test("rejects placeholder config and missing binaries", async () => {
    const root = await createRoot()
    const record = installRecord(root)

    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const store = yield* ClawctlStoreService
          const runtime = yield* ClawctlRuntimeService
          yield* store.writeInstallRecord(record)
          return yield* runtime.runChat(record, "hello-runtime")
        }),
        makeRuntimeTestLayer(root),
      ),
    ).rejects.toThrow("shared config key is missing or placeholder: CLAW_API_KEY")

    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const store = yield* ClawctlStoreService
          const runtime = yield* ClawctlRuntimeService
          yield* store.writeInstallRecord(record)
          yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
          return yield* runtime.runChat(record, "hello-runtime")
        }),
        makeRuntimeTestLayer(root),
      ),
    ).rejects.toThrow("missing binary for openclaw")
  })

  test("exposes the one-shot ping prompt", async () => {
    const root = await createRoot()

    const output = await runWithLayer(
      Effect.gen(function* () {
        const runtime = yield* ClawctlRuntimeService
        return runtime.pingText()
      }),
      makeRuntimeTestLayer(root),
    )

    expect(output).toBe("Reply with exactly the single word pong.")
  })

  test("shared config stays redacted at the store boundary", async () => {
    const root = await createRoot()

    const config = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        return yield* store.readSharedConfig
      }),
      makeRuntimeTestLayer(root),
    )

    expect(config.CLAW_API_KEY).toEqual(Redacted.make("secret"))
    expect(sharedConfigToEntries(config).CLAW_API_KEY).toBe("secret")
  })
})
