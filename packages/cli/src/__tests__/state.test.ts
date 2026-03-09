import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

import type { InstallRecord } from "../adapter/types.ts"
import { userError } from "../errors.ts"
import { ClawctlPathsService } from "../paths-service.ts"
import { ClawctlStoreService } from "../store-service.ts"
import { makeStoreTestLayer, runWithLayer } from "../test-layer.ts"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-store-"))
  tempRoots.push(root)
  return root
}

function record(
  root: string,
  input: Partial<InstallRecord> & Pick<InstallRecord, "implementation" | "resolvedVersion">,
) {
  return {
    implementation: input.implementation,
    requestedVersion: input.requestedVersion ?? input.resolvedVersion,
    resolvedVersion: input.resolvedVersion,
    backend: input.backend ?? "local",
    installStrategy: input.installStrategy ?? "github-release",
    installRoot: input.installRoot ?? join(root, "installs", "local", input.implementation, input.resolvedVersion),
    entrypointCommand: input.entrypointCommand ?? ["/bin/echo"],
    platform: input.platform ?? { os: "darwin", arch: "arm64" },
    sourceReference: input.sourceReference ?? "fixture",
    verificationSummary: input.verificationSummary,
    installedAt: input.installedAt ?? "2026-03-09T00:00:00.000Z",
    supportTier: input.supportTier ?? "tier1",
  } satisfies InstallRecord
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("store service", () => {
  test("ensures and updates shared config", async () => {
    const root = await createRoot()

    const config = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        yield* store.ensureSharedConfig
        yield* store.setSharedConfigValue("CLAW_API_KEY", "secret")
        return yield* store.readSharedConfig
      }),
      makeStoreTestLayer(root),
    )

    expect(config.CLAW_MODEL).toBe("moonshotai/kimi-k2.5")
    expect(String(config.CLAW_API_KEY)).toBe("<redacted>")
  })

  test("lists installed records and resolves the latest version", async () => {
    const root = await createRoot()

    const records = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        yield* store.writeInstallRecord(record(root, { implementation: "openclaw", resolvedVersion: "2026.3.6" }))
        yield* store.writeInstallRecord(record(root, { implementation: "openclaw", resolvedVersion: "2026.3.7" }))
        yield* store.writeInstallRecord(
          record(root, { implementation: "nanobot", resolvedVersion: "0.1.4.post4", supportTier: "tier2" }),
        )

        return {
          all: yield* store.listInstallRecords,
          explicit: yield* store.resolveInstalledRecord("openclaw", "2026.3.6"),
          latest: yield* store.resolveInstalledRecord("openclaw"),
        }
      }),
      makeStoreTestLayer(root),
    )

    expect(records.all.map((entry) => `${entry.implementation}@${entry.resolvedVersion}`)).toEqual([
      "nanobot@0.1.4.post4",
      "openclaw@2026.3.6",
      "openclaw@2026.3.7",
    ])
    expect(records.latest.resolvedVersion).toBe("2026.3.7")
    expect(records.explicit.resolvedVersion).toBe("2026.3.6")
  })

  test("stores and clears the current selection", async () => {
    const root = await createRoot()

    const current = await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        yield* store.writeCurrentSelection({
          implementation: "openclaw",
          version: "2026.3.7",
          backend: "local",
        })
        const first = yield* store.readCurrentSelection
        yield* store.clearCurrentSelection
        const second = yield* store.readCurrentSelection
        return { first, second }
      }),
      makeStoreTestLayer(root),
    )

    expect(current.first).toEqual({
      implementation: "openclaw",
      version: "2026.3.7",
      backend: "local",
    })
    expect(current.second).toBeUndefined()
  })

  test("cleans partial installs and orphaned runtimes and removes installs", async () => {
    const root = await createRoot()

    const report = await runWithLayer(
      Effect.gen(function* () {
        const paths = yield* ClawctlPathsService
        const store = yield* ClawctlStoreService
        const install = record(root, { implementation: "openclaw", resolvedVersion: "2026.3.7" })
        yield* store.writeInstallRecord(install)

        const partialDir = join(paths.paths.installDir, "local", "openclaw", "2026.3.7.partial-stale")
        const orphanRuntime = join(paths.paths.runtimeDir, "local", "openclaw", "2026.3.5")
        const liveRuntime = join(paths.paths.runtimeDir, "local", "openclaw", "2026.3.7")
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(partialDir, { recursive: true })
            await mkdir(orphanRuntime, { recursive: true })
            await mkdir(liveRuntime, { recursive: true })
            await writeFile(join(partialDir, "junk.txt"), "junk", "utf8")
          },
          catch: (cause) => userError("state.test", String(cause)),
        })

        const removedPartial = yield* store.cleanupPartialInstallDirectories("openclaw")
        const removedRuntime = yield* store.cleanupOrphanedRuntimeDirectories("openclaw")
        yield* store.removeRuntime("openclaw", "2026.3.7")
        yield* store.removeInstall(install)

        return {
          installDir: install.installRoot,
          orphanRuntime,
          partialDir,
          removedPartial,
          removedRuntime,
          runtimeDir: liveRuntime,
        }
      }),
      makeStoreTestLayer(root),
    )

    expect(report.removedPartial).toBe(1)
    expect(report.removedRuntime).toBe(1)
    expect(await Bun.file(report.partialDir).exists()).toBe(false)
    expect(await Bun.file(report.orphanRuntime).exists()).toBe(false)
    expect(await Bun.file(report.runtimeDir).exists()).toBe(false)
    expect(await Bun.file(report.installDir).exists()).toBe(false)
  })

  test("fails for missing installed records", async () => {
    const root = await createRoot()

    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const store = yield* ClawctlStoreService
          return yield* store.resolveInstalledRecord("ghostclaw")
        }),
        makeStoreTestLayer(root),
      ),
    ).rejects.toThrow("implementation is not installed: ghostclaw")

    await runWithLayer(
      Effect.gen(function* () {
        const store = yield* ClawctlStoreService
        yield* store.writeInstallRecord(record(root, { implementation: "openclaw", resolvedVersion: "2026.3.7" }))
      }),
      makeStoreTestLayer(root),
    )

    await expect(
      runWithLayer(
        Effect.gen(function* () {
          const store = yield* ClawctlStoreService
          return yield* store.resolveInstalledRecord("openclaw", "2026.3.5")
        }),
        makeStoreTestLayer(root),
      ),
    ).rejects.toThrow("version is not installed: openclaw@2026.3.5")
  })
})
