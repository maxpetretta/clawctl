import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ensureBaseLayout,
  installMetadataFile,
  installParentDir,
  installRoot,
  listInstalledImplementationDirs,
  partialInstallRoot,
  resolvePaths,
  runtimeHomeDir,
  runtimeImplementationDir,
  runtimeRoot,
  runtimeStateDir,
  runtimeWorkspaceDir,
} from "./paths.ts"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-paths-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("paths", () => {
  test("resolves all derived directories under the chosen root", async () => {
    const root = await createRoot()
    const paths = resolvePaths(root)

    expect(installRoot(paths, "openclaw", "2026.3.7")).toContain("/installs/local/openclaw/2026.3.7")
    expect(installParentDir(paths, "openclaw")).toContain("/installs/local/openclaw")
    expect(partialInstallRoot(paths, "openclaw", "2026.3.7", "abc")).toContain("2026.3.7.partial-abc")
    expect(installMetadataFile(paths, "openclaw", "2026.3.7")).toContain("/install.json")
    expect(runtimeRoot(paths, "openclaw", "2026.3.7")).toContain("/runtimes/local/openclaw/2026.3.7")
    expect(runtimeImplementationDir(paths, "openclaw")).toContain("/runtimes/local/openclaw")
    expect(runtimeHomeDir(paths, "openclaw", "2026.3.7")).toContain("/home")
    expect(runtimeWorkspaceDir(paths, "openclaw", "2026.3.7")).toContain("/workspace")
    expect(runtimeStateDir(paths, "openclaw", "2026.3.7")).toContain("/state")

    await ensureBaseLayout(paths)
    expect(await Bun.file(paths.currentFile).exists()).toBe(false)
  })

  test("lists installed implementation directories when present", async () => {
    const root = await createRoot()
    const paths = resolvePaths(root)
    expect(await listInstalledImplementationDirs(paths)).toEqual([])

    await mkdir(join(paths.installDir, "local", "openclaw"), { recursive: true })
    await mkdir(join(paths.installDir, "local", "nanobot"), { recursive: true })

    expect(await listInstalledImplementationDirs(paths)).toEqual(["nanobot", "openclaw"])
  })
})
