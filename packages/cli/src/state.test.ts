import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { InstallRecord } from "./adapter/types.ts"
import { resolvePaths } from "./paths.ts"
import {
  cleanupOrphanedRuntimeDirectories,
  cleanupPartialInstallDirectories,
  clearCurrentSelection,
  installBinary,
  listInstallRecords,
  readCurrentSelection,
  readInstallRecord,
  removeInstall,
  removeRuntime,
  resolveInstalledRecord,
  writeCurrentSelection,
  writeInstallRecord,
} from "./state.ts"

const tempRoots: string[] = []

async function createPaths() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-state-"))
  tempRoots.push(root)
  return resolvePaths(root)
}

function record(
  input: Partial<InstallRecord> & Pick<InstallRecord, "implementation" | "resolvedVersion">,
): InstallRecord {
  return {
    implementation: input.implementation,
    requestedVersion: input.requestedVersion ?? input.resolvedVersion,
    resolvedVersion: input.resolvedVersion,
    backend: input.backend ?? "local",
    installStrategy: input.installStrategy ?? "github-release",
    installRoot: input.installRoot ?? `/tmp/${input.implementation}/${input.resolvedVersion}`,
    entrypointCommand: input.entrypointCommand ?? ["/bin/echo"],
    platform: input.platform ?? { os: "darwin", arch: "arm64" },
    sourceReference: input.sourceReference ?? "fixture",
    verificationSummary: input.verificationSummary,
    installedAt: input.installedAt ?? "2026-03-09T00:00:00.000Z",
    supportTier: input.supportTier ?? "tier1",
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("state persistence", () => {
  test("lists installed records and resolves the latest version", async () => {
    const paths = await createPaths()
    await writeInstallRecord(paths, record({ implementation: "openclaw", resolvedVersion: "2026.3.6" }))
    await writeInstallRecord(paths, record({ implementation: "openclaw", resolvedVersion: "2026.3.7" }))
    await writeInstallRecord(
      paths,
      record({ implementation: "nanobot", resolvedVersion: "0.1.4.post4", supportTier: "tier2" }),
    )

    const records = await listInstallRecords(paths)
    expect(records.map((entry) => `${entry.implementation}@${entry.resolvedVersion}`)).toEqual([
      "nanobot@0.1.4.post4",
      "openclaw@2026.3.6",
      "openclaw@2026.3.7",
    ])

    const latest = await resolveInstalledRecord(paths, "openclaw")
    expect(latest.resolvedVersion).toBe("2026.3.7")

    const explicit = await resolveInstalledRecord(paths, "openclaw", "2026.3.6")
    expect(explicit.resolvedVersion).toBe("2026.3.6")
  })

  test("stores and clears the current selection", async () => {
    const paths = await createPaths()
    await writeCurrentSelection(paths, {
      implementation: "openclaw",
      version: "2026.3.7",
      backend: "local",
    })

    expect(await readCurrentSelection(paths)).toEqual({
      implementation: "openclaw",
      version: "2026.3.7",
      backend: "local",
    })

    await clearCurrentSelection(paths)
    expect(await readCurrentSelection(paths)).toBeUndefined()

    await expect(clearCurrentSelection(paths)).resolves.toBeUndefined()
  })

  test("removes partial installs and orphaned runtimes", async () => {
    const paths = await createPaths()
    await writeInstallRecord(paths, record({ implementation: "openclaw", resolvedVersion: "2026.3.7" }))

    const partialDir = join(paths.installDir, "local", "openclaw", "2026.3.7.partial-stale")
    const orphanRuntime = join(paths.runtimeDir, "local", "openclaw", "2026.3.5")
    await mkdir(partialDir, { recursive: true })
    await mkdir(orphanRuntime, { recursive: true })
    await writeFile(join(partialDir, "junk.txt"), "junk", "utf8")

    expect(await cleanupPartialInstallDirectories(paths, "openclaw")).toBe(1)
    expect(await cleanupOrphanedRuntimeDirectories(paths, "openclaw")).toBe(1)

    expect(await Bun.file(partialDir).exists()).toBe(false)
    expect(await Bun.file(orphanRuntime).exists()).toBe(false)
  })

  test("removes an installed version", async () => {
    const paths = await createPaths()
    const install = record({
      implementation: "openclaw",
      resolvedVersion: "2026.3.7",
      installRoot: join(paths.installDir, "local", "openclaw", "2026.3.7"),
    })
    await writeInstallRecord(paths, install)

    await removeInstall(paths, install)

    expect(await Bun.file(join(paths.installDir, "local", "openclaw", "2026.3.7")).exists()).toBe(false)
  })

  test("handles missing records and runtime cleanup edge cases", async () => {
    const paths = await createPaths()

    expect(await readInstallRecord(paths, "ghostclaw", "1.0.0")).toBeUndefined()
    await expect(resolveInstalledRecord(paths, "ghostclaw")).rejects.toThrow(
      "implementation is not installed: ghostclaw",
    )

    await writeInstallRecord(paths, record({ implementation: "openclaw", resolvedVersion: "2026.3.7" }))
    await expect(resolveInstalledRecord(paths, "openclaw", "2026.3.5")).rejects.toThrow(
      "version is not installed: openclaw@2026.3.5",
    )

    expect(await cleanupPartialInstallDirectories(paths, "ghostclaw")).toBe(0)
    expect(await cleanupOrphanedRuntimeDirectories(paths, "ghostclaw")).toBe(0)
  })

  test("installs executable bits and removes runtimes", async () => {
    const paths = await createPaths()
    const binaryPath = join(paths.rootDir, "bin", "tool.sh")
    const runtimePath = join(paths.runtimeDir, "local", "openclaw", "2026.3.7")
    await mkdir(join(paths.rootDir, "bin"), { recursive: true })
    await mkdir(runtimePath, { recursive: true })
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", "utf8")

    await installBinary(binaryPath)
    await removeRuntime(paths, "openclaw", "2026.3.7")

    expect((await stat(binaryPath)).mode & 0o111).toBeGreaterThan(0)
    expect(await Bun.file(runtimePath).exists()).toBe(false)
  })
})
