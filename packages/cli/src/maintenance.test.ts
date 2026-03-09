import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { InstallRecord } from "./adapter/types.ts"
import {
  isPlatformSupported,
  requiredCommandsForInstall,
  runCleanup,
  runDoctor,
  sharedConfigIssues,
} from "./maintenance.ts"
import { resolvePaths } from "./paths.ts"
import { setSharedConfigValue } from "./shared-config.ts"
import { writeCurrentSelection, writeInstallRecord } from "./state.ts"

const tempRoots: string[] = []

async function createPaths() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-maintenance-"))
  tempRoots.push(root)
  return resolvePaths(root)
}

async function writeExecutable(destination: string) {
  await writeFile(destination, "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(destination, 0o755)
}

function record(
  input: Partial<InstallRecord> & Pick<InstallRecord, "implementation" | "resolvedVersion">,
): InstallRecord {
  return {
    implementation: input.implementation,
    requestedVersion: input.requestedVersion ?? input.resolvedVersion,
    resolvedVersion: input.resolvedVersion,
    backend: input.backend ?? "local",
    installStrategy: input.installStrategy ?? "npm-package",
    installRoot: input.installRoot ?? "/tmp/install-root",
    entrypointCommand: input.entrypointCommand ?? [],
    platform: input.platform ?? { os: "darwin", arch: "arm64" },
    sourceReference: input.sourceReference ?? "fixture",
    verificationSummary: input.verificationSummary,
    installedAt: input.installedAt ?? "2026-03-09T00:00:00.000Z",
    supportTier: input.supportTier ?? "tier2",
  }
}

afterEach(async () => {
  process.env.CLAWCTL_GIT_BIN = undefined
  process.env.CLAWCTL_NPM_BIN = undefined
  process.env.CLAWCTL_DOCKER_BIN = undefined
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("maintenance", () => {
  test("exposes pure install and config helper behavior", () => {
    expect(isPlatformSupported([{ os: "darwin", arch: "arm64" }], { os: "darwin", arch: "arm64" })).toBe(true)
    expect(isPlatformSupported([{ os: "linux", arch: "arm64" }], { os: "darwin", arch: "arm64" })).toBe(false)

    expect(
      requiredCommandsForInstall({
        strategy: "github-release",
        priority: 1,
        repository: "example/example",
        versionSource: { kind: "github-releases", repository: "example/example" },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        assetRules: [
          {
            match: { os: "darwin", arch: "arm64" },
            pattern: "tool.tar.gz",
            archive: { kind: "tar.gz", binaryPath: "tool" },
          },
          {
            match: { os: "darwin", arch: "arm64" },
            pattern: "tool.zip",
            archive: { kind: "zip", binaryPath: "tool" },
          },
        ],
        verification: { kind: "none" },
      }),
    ).toEqual(["tar", "unzip"])
    expect(
      requiredCommandsForInstall({
        strategy: "python-package",
        priority: 1,
        packageName: "nanobot-ai",
        versionSource: { kind: "pypi", packageName: "nanobot-ai" },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        installer: "pip-venv",
        entrypoint: "nanobot",
      }),
    ).toEqual(["python3", "pip3"])
    expect(
      requiredCommandsForInstall({
        strategy: "docker-build",
        priority: 1,
        context: ".",
        dockerfile: "Dockerfile",
        image: "clawctl:test",
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        versionSource: { kind: "static", versions: ["latest"] },
      }),
    ).toEqual([process.env.CLAWCTL_DOCKER_BIN ?? "docker"])
    expect(
      requiredCommandsForInstall({
        strategy: "source-build",
        priority: 1,
        repository: "example/example",
        versionSource: { kind: "static", versions: ["v1.0.0"] },
        supportedPlatforms: [{ os: "darwin", arch: "arm64" }],
        buildHook: "install",
      }),
    ).toEqual([process.env.CLAWCTL_GIT_BIN ?? "git", process.env.CLAWCTL_BUN_BIN ?? "bun"])

    expect(
      sharedConfigIssues({ CLAW_API_KEY: "replace-me", CLAW_MODEL: "ok" }, ["CLAW_API_KEY", "CLAW_MODEL"]),
    ).toEqual(["CLAW_API_KEY"])
  })

  test("doctor reports healthy installed adapters", async () => {
    const paths = await createPaths()
    const toolsDir = join(paths.rootDir, "tools")
    const npmPath = join(toolsDir, "npm")
    const openclawPath = join(toolsDir, "openclaw")
    await mkdir(toolsDir, { recursive: true })
    await writeExecutable(npmPath)
    await writeExecutable(openclawPath)
    process.env.CLAWCTL_NPM_BIN = npmPath

    await setSharedConfigValue(paths, "CLAW_API_KEY", "secret")
    await writeInstallRecord(
      paths,
      record({
        implementation: "openclaw",
        resolvedVersion: "2026.3.7",
        entrypointCommand: [openclawPath],
        installRoot: join(paths.installDir, "local", "openclaw", "2026.3.7"),
      }),
    )

    const report = await runDoctor(paths, "openclaw")
    expect(report.ok).toBe(true)
    expect(report.checks.some((check) => check.label === "openclaw:entrypoint:2026.3.7" && check.ok)).toBe(true)
  })

  test("doctor uses current selection and handles entrypoint-free installs", async () => {
    const paths = await createPaths()
    process.env.CLAWCTL_GIT_BIN = "/usr/bin/git"
    await writeInstallRecord(
      paths,
      record({
        implementation: "nanoclaw",
        resolvedVersion: "main",
        installStrategy: "repo-bootstrap",
        entrypointCommand: [],
        installRoot: join(paths.installDir, "local", "nanoclaw", "main"),
        supportTier: "tier3",
      }),
    )
    await writeCurrentSelection(paths, {
      implementation: "nanoclaw",
      version: "main",
      backend: "local",
    })

    const report = await runDoctor(paths)
    expect(report.ok).toBe(true)
    expect(
      report.checks.some(
        (check) => check.label === "nanoclaw:entrypoint:main" && check.detail === "no direct local entrypoint declared",
      ),
    ).toBe(true)
  })

  test("doctor reports missing shared config and tools", async () => {
    const paths = await createPaths()
    process.env.CLAWCTL_DOCKER_BIN = join(paths.rootDir, "missing-docker")

    const report = await runDoctor(paths, "piclaw")
    expect(report.ok).toBe(false)
    expect(report.checks.some((check) => check.label.includes("piclaw:docker:tool") && !check.ok)).toBe(true)
  })

  test("doctor discovers installed adapters when no target is provided", async () => {
    const paths = await createPaths()
    const toolsDir = join(paths.rootDir, "tools")
    const tarPath = join(toolsDir, "tar")
    const unzipPath = join(toolsDir, "unzip")
    await mkdir(toolsDir, { recursive: true })
    await writeExecutable(tarPath)
    await writeExecutable(unzipPath)
    await writeInstallRecord(
      paths,
      record({
        implementation: "picoclaw",
        resolvedVersion: "v0.2.0",
        installStrategy: "github-release",
        entrypointCommand: [join(toolsDir, "picoclaw")],
        installRoot: join(paths.installDir, "local", "picoclaw", "v0.2.0"),
        supportTier: "tier1",
      }),
    )

    const report = await runDoctor(paths)
    expect(report.checks.some((check) => check.label === "picoclaw:install:v0.2.0")).toBe(true)
  })

  test("cleanup clears stale current selections", async () => {
    const paths = await createPaths()
    await writeCurrentSelection(paths, {
      implementation: "openclaw",
      version: "2026.3.7",
      backend: "local",
    })

    const report = await runCleanup(paths)
    expect(report.clearedCurrent).toBe(true)
  })

  test("doctor returns registry-only status when nothing is installed", async () => {
    const paths = await createPaths()

    const report = await runDoctor(paths)
    expect(report.ok).toBe(true)
    expect(report.checks).toEqual([{ label: "registry", ok: true, detail: "adapter registry is valid" }])
  })

  test("cleanup can target a single implementation", async () => {
    const paths = await createPaths()
    const partialDir = join(paths.installDir, "local", "openclaw", "2026.3.7.partial-stale")
    const runtimeDir = join(paths.runtimeDir, "local", "openclaw", "2026.3.6")
    await mkdir(partialDir, { recursive: true })
    await mkdir(runtimeDir, { recursive: true })

    const report = await runCleanup(paths, "openclaw")
    expect(report.removedPartialInstalls).toBe(1)
    expect(report.removedRuntimeDirs).toBe(1)
  })
})
