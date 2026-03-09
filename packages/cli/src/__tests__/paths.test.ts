import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

import { ClawctlPathsService } from "../paths-service.ts"
import { makePathsLayer, runWithLayer } from "../test-layer.ts"

const tempRoots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-paths-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("paths service", () => {
  test("resolves all derived directories under the chosen root", async () => {
    const root = await createRoot()

    const result = await runWithLayer(
      Effect.gen(function* () {
        const paths = yield* ClawctlPathsService
        return {
          currentFile: paths.paths.currentFile,
          installMetadataFile: paths.installMetadataFile("openclaw", "2026.3.7"),
          installParentDir: paths.installParentDir("openclaw"),
          installRoot: paths.installRoot("openclaw", "2026.3.7"),
          partialInstallRoot: paths.partialInstallRoot("openclaw", "2026.3.7", "abc"),
          runtimeHomeDir: paths.runtimeHomeDir("openclaw", "2026.3.7"),
          runtimeImplementationDir: paths.runtimeImplementationDir("openclaw"),
          runtimeRoot: paths.runtimeRoot("openclaw", "2026.3.7"),
          runtimeStateDir: paths.runtimeStateDir("openclaw", "2026.3.7"),
          runtimeWorkspaceDir: paths.runtimeWorkspaceDir("openclaw", "2026.3.7"),
        }
      }),
      makePathsLayer(root),
    )

    expect(result.installRoot).toContain("/installs/local/openclaw/2026.3.7")
    expect(result.installParentDir).toContain("/installs/local/openclaw")
    expect(result.partialInstallRoot).toContain("2026.3.7.partial-abc")
    expect(result.installMetadataFile).toContain("/install.json")
    expect(result.runtimeRoot).toContain("/runtimes/local/openclaw/2026.3.7")
    expect(result.runtimeImplementationDir).toContain("/runtimes/local/openclaw")
    expect(result.runtimeHomeDir).toContain("/home")
    expect(result.runtimeWorkspaceDir).toContain("/workspace")
    expect(result.runtimeStateDir).toContain("/state")
    expect(await Bun.file(result.currentFile).exists()).toBe(false)
  })
})
