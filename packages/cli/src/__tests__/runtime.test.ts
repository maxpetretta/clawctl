import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Option, Redacted } from "effect"

import type { InstallRecord } from "../adapter/types.ts"
import { userError } from "../errors.ts"
import { ClawctlPathsService } from "../paths-service.ts"
import { ClawctlRuntimeService } from "../runtime-service.ts"
import { sharedConfigToEntries } from "../shared-config.ts"
import { ClawctlStoreService } from "../store-service.ts"
import { makeRuntimeTestLayer, runWithLayer } from "../test-layer.ts"

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

async function writeOpenclawExecutable(destination: string) {
  await writeExecutable(
    destination,
    `#!/bin/sh
if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then
  mkdir -p "\${OPENCLAW_STATE_DIR}"
  touch "\${OPENCLAW_STATE_DIR}/ready"
  trap 'rm -f "\${OPENCLAW_STATE_DIR}/ready"; exit 0' TERM INT
  while true; do
    sleep 1
  done
fi

if [ "$1" = "gateway" ] && [ "$2" = "health" ]; then
  if [ -f "\${OPENCLAW_STATE_DIR}/ready" ]; then
    echo '{"state":"running"}'
    exit 0
  fi
  echo '{"state":"starting"}' >&2
  exit 1
fi

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
}

async function stopDetachedProcesses(root: string) {
  const runtimeDir = join(root, "runtimes", "local")
  try {
    const implementations = await readdir(runtimeDir)
    for (const implementation of implementations) {
      const implementationDir = join(runtimeDir, implementation)
      const versions = await readdir(implementationDir)
      for (const version of versions) {
        const metadata = join(implementationDir, version, "runtime.json")
        try {
          const parsed = JSON.parse(await readFile(metadata, "utf8")) as { pid?: number }
          if (typeof parsed.pid === "number") {
            try {
              process.kill(parsed.pid, "SIGTERM")
            } catch {
              // Ignore cleanup races with already-exited processes.
            }
          }
        } catch {
          // Ignore malformed or missing runtime metadata during cleanup.
        }
      }
    }
  } catch {
    // Ignore missing runtime directories during cleanup.
  }
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
  const roots = tempRoots.splice(0)
  await Promise.all(roots.map((root) => stopDetachedProcesses(root)))
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("runtime service", () => {
  test("ensureActiveChatTarget uses the current selection", async () => {
    const root = await createRoot()
    const record = installRecord(root)
    await writeOpenclawExecutable(record.entrypointCommand[0] ?? join(root, "bin", "openclaw"))

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
    await writeOpenclawExecutable(record.entrypointCommand[0] ?? join(root, "bin", "openclaw"))

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
        const runtimeState = yield* runtime.runtimeState(record)
        const current = yield* store.readCurrentSelection
        const configFile = join(paths.runtimeRoot("openclaw", "2026.3.7"), "home", ".openclaw", "openclaw.json")
        return {
          activatedRecord,
          configText: yield* Effect.tryPromise({
            try: () => Bun.file(configFile).text(),
            catch: (cause) => userError("runtime.test", String(cause)),
          }),
          current,
          runtimeState,
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
    expect(activated.runtimeState.state).toBe("running")
    expect(activated.runtimeState.port).toBe(28789)
  })

  test("runChatDirect renders config and normalizes output", async () => {
    const root = await createRoot()
    const record = installRecord(root)
    await writeOpenclawExecutable(record.entrypointCommand[0] ?? join(root, "bin", "openclaw"))

    const output = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        const runtime = yield* ClawctlRuntimeService
        yield* store.writeInstallRecord(record)
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        return yield* runtime.runChatDirect(record, "hello-runtime")
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
          return yield* runtime.runChatDirect(record, "hello-runtime")
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
          return yield* runtime.runChatDirect(record, "hello-runtime")
        }),
        makeRuntimeTestLayer(root),
      ),
    ).rejects.toThrow("missing binary for openclaw")
  })

  test("stopSelection stops a native-daemon runtime", async () => {
    const root = await createRoot()
    const record = installRecord(root)
    await writeOpenclawExecutable(record.entrypointCommand[0] ?? join(root, "bin", "openclaw"))

    const snapshot = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        const runtime = yield* ClawctlRuntimeService
        yield* store.writeInstallRecord(record)
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        yield* runtime.activateSelection({
          implementation: "openclaw",
          version: "2026.3.7",
        })
        yield* runtime.stopSelection(Option.some("openclaw@2026.3.7"))
        return yield* runtime.runtimeState(record)
      }),
      makeRuntimeTestLayer(root),
    )

    expect(snapshot.state).toBe("stopped")
  })

  test("exposes the managed ping prompt", async () => {
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
