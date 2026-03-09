import { readdir } from "node:fs/promises"
import { resolve } from "node:path"

import { getRegisteredImplementation } from "./adapter/registry.ts"
import type { InstallManifest, PlatformSelector } from "./adapter/schema.ts"
import type { ClawctlPaths } from "./paths.ts"
import { ensureBaseLayout } from "./paths.ts"
import { currentHostPlatform } from "./platform.ts"
import { readSharedConfig } from "./shared-config.ts"
import {
  cleanupOrphanedRuntimeDirectories,
  cleanupPartialInstallDirectories,
  clearCurrentSelection,
  listInstallRecords,
  readCurrentSelection,
  resolveInstalledRecord,
} from "./state.ts"
import {
  bunExecutable,
  commandExists,
  dockerExecutable,
  gitExecutable,
  npmExecutable,
  uvExecutable,
} from "./tooling.ts"

export type DoctorCheck = {
  detail: string
  label: string
  ok: boolean
}

export type CleanupReport = {
  clearedCurrent: boolean
  removedPartialInstalls: number
  removedRuntimeDirs: number
}

export function isPlatformSupported(supportedPlatforms: PlatformSelector[], host: PlatformSelector): boolean {
  return supportedPlatforms.some(
    (candidate) =>
      candidate.os === host.os &&
      candidate.arch === host.arch &&
      (candidate.libc === undefined || candidate.libc === host.libc),
  )
}

export function requiredCommandsForInstall(strategy: InstallManifest): string[] {
  switch (strategy.strategy) {
    case "github-release": {
      const required = new Set<string>()
      for (const rule of strategy.assetRules) {
        if (rule.archive.kind === "tar.gz") {
          required.add("tar")
        }
        if (rule.archive.kind === "zip") {
          required.add("unzip")
        }
      }
      return [...required]
    }
    case "npm-package":
      return [npmExecutable()]
    case "python-package":
      return strategy.installer.startsWith("uv-") ? [uvExecutable()] : ["python3", "pip3"]
    case "repo-bootstrap":
      return [gitExecutable()]
    case "docker-build":
      return [dockerExecutable()]
    case "source-build":
      return [gitExecutable(), bunExecutable()]
  }
}

async function listSubdirectories(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

export function sharedConfigIssues(config: Record<string, string>, keys: string[]): string[] {
  return keys.filter((key) => {
    const value = config[key]?.trim()
    return !value || value === "replace-me"
  })
}

async function selectDoctorTargets(paths: ClawctlPaths, target?: string): Promise<string[]> {
  if (target) {
    return [target]
  }

  const current = await readCurrentSelection(paths)
  if (current) {
    return [current.implementation]
  }

  const installed = await listInstallRecords(paths)
  if (installed.length > 0) {
    return [...new Set(installed.map((record) => record.implementation))]
  }

  return []
}

export async function runDoctor(paths: ClawctlPaths, target?: string): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const config = await readSharedConfig(paths)
  const host = currentHostPlatform()
  const checks: DoctorCheck[] = [{ label: "registry", ok: true, detail: "adapter registry is valid" }]
  const targets = await selectDoctorTargets(paths, target)
  const installedRecords = await listInstallRecords(paths)

  for (const implementationId of targets) {
    const registration = getRegisteredImplementation(implementationId)
    checks.push({
      label: `${implementationId}:manifest`,
      ok: true,
      detail: `${registration.manifest.supportTier} adapter`,
    })

    for (const backend of registration.manifest.backends) {
      if (!backend.supported) {
        checks.push({
          label: `${implementationId}:${backend.kind}`,
          ok: true,
          detail: "backend declared but not supported yet",
        })
        continue
      }

      const strategy = backend.install[0] as InstallManifest

      checks.push({
        label: `${implementationId}:${backend.kind}:platform`,
        ok: isPlatformSupported(strategy.supportedPlatforms, host),
        detail: `${host.os}-${host.arch}`,
      })

      for (const command of requiredCommandsForInstall(strategy)) {
        checks.push({
          label: `${implementationId}:${backend.kind}:tool:${command}`,
          ok: await commandExists(command),
          detail: "required for install/runtime",
        })
      }
    }

    const sharedKeys = registration.manifest.config.sharedKeys
    if (sharedKeys.length > 0) {
      const missingKeys = sharedConfigIssues(config, sharedKeys)
      checks.push({
        label: `${implementationId}:shared-config`,
        ok: missingKeys.length === 0,
        detail: missingKeys.length === 0 ? "required shared keys present" : `missing ${missingKeys.join(", ")}`,
      })
    }

    const records = installedRecords.filter((record) => record.implementation === implementationId)
    if (records.length === 0) {
      checks.push({
        label: `${implementationId}:install`,
        ok: true,
        detail: "not installed",
      })
      continue
    }

    for (const record of records) {
      const entrypoint = record.entrypointCommand[0]
      checks.push({
        label: `${implementationId}:install:${record.resolvedVersion}`,
        ok: true,
        detail: `installed via ${record.installStrategy}`,
      })
      if (!entrypoint) {
        checks.push({
          label: `${implementationId}:entrypoint:${record.resolvedVersion}`,
          ok: true,
          detail: "no direct local entrypoint declared",
        })
        continue
      }
      checks.push({
        label: `${implementationId}:entrypoint:${record.resolvedVersion}`,
        ok: await commandExists(entrypoint),
        detail: entrypoint,
      })
    }
  }

  return {
    checks,
    ok: checks.every((check) => check.ok),
  }
}

export async function runCleanup(paths: ClawctlPaths, target?: string): Promise<CleanupReport> {
  await ensureBaseLayout(paths)

  const installImplementations = await listSubdirectories(resolve(paths.installDir, "local"))
  const runtimeImplementations = await listSubdirectories(resolve(paths.runtimeDir, "local"))
  const targets = target === undefined ? [...new Set([...installImplementations, ...runtimeImplementations])] : [target]

  let removedPartialInstalls = 0
  let removedRuntimeDirs = 0

  for (const implementationId of targets) {
    removedPartialInstalls += await cleanupPartialInstallDirectories(paths, implementationId)
    removedRuntimeDirs += await cleanupOrphanedRuntimeDirectories(paths, implementationId)
  }

  let clearedCurrent = false
  const current = await readCurrentSelection(paths)
  if (current) {
    try {
      await resolveInstalledRecord(paths, current.implementation, current.version)
    } catch {
      await clearCurrentSelection(paths)
      clearedCurrent = true
    }
  }

  return {
    clearedCurrent,
    removedPartialInstalls,
    removedRuntimeDirs,
  }
}
