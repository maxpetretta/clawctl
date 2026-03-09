import { chmod, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"

import type { CurrentSelection, InstallRecord } from "./adapter/types.ts"
import type { ClawctlPaths } from "./paths.ts"
import {
  ensureBaseLayout,
  installMetadataFile,
  installParentDir,
  installRoot,
  listInstalledImplementationDirs,
  runtimeHomeDir,
  runtimeImplementationDir,
  runtimeRoot,
  runtimeStateDir,
  runtimeWorkspaceDir,
} from "./paths.ts"

export async function writeInstallRecord(paths: ClawctlPaths, record: InstallRecord): Promise<void> {
  const root = installRoot(paths, record.implementation, record.resolvedVersion, record.backend)
  await mkdir(root, { recursive: true })
  await writeFile(
    installMetadataFile(paths, record.implementation, record.resolvedVersion, record.backend),
    JSON.stringify(record, null, 2),
  )
}

export async function readInstallRecord(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): Promise<InstallRecord | undefined> {
  try {
    const source = await readFile(installMetadataFile(paths, implementation, version, backend), "utf8")
    return JSON.parse(source) as InstallRecord
  } catch {
    return undefined
  }
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

export async function listInstallRecords(paths: ClawctlPaths): Promise<InstallRecord[]> {
  await ensureBaseLayout(paths)
  const implementations = await listInstalledImplementationDirs(paths)
  const records: InstallRecord[] = []

  for (const implementation of implementations) {
    let versions: string[] = []
    try {
      versions = await readdir(installParentDir(paths, implementation, "local"))
    } catch {
      continue
    }

    for (const version of versions) {
      const record = await readInstallRecord(paths, implementation, version)
      if (record) {
        records.push(record)
      }
    }
  }

  return records.sort((left, right) => {
    if (left.implementation === right.implementation) {
      return compareVersions(left.resolvedVersion, right.resolvedVersion)
    }
    return left.implementation.localeCompare(right.implementation)
  })
}

export async function resolveInstalledRecord(
  paths: ClawctlPaths,
  implementation: string,
  version?: string,
): Promise<InstallRecord> {
  const records = (await listInstallRecords(paths)).filter((record) => record.implementation === implementation)

  if (records.length === 0) {
    throw new Error(`implementation is not installed: ${implementation}`)
  }

  if (version) {
    const match = records.find((record) => record.resolvedVersion === version || record.requestedVersion === version)
    if (!match) {
      throw new Error(`version is not installed: ${implementation}@${version}`)
    }
    return match
  }

  const [latest] = [...records].sort((left, right) => compareVersions(right.resolvedVersion, left.resolvedVersion))
  if (!latest) {
    throw new Error(`implementation is not installed: ${implementation}`)
  }
  return latest
}

export async function readCurrentSelection(paths: ClawctlPaths): Promise<CurrentSelection | undefined> {
  try {
    const source = await readFile(paths.currentFile, "utf8")
    return JSON.parse(source) as CurrentSelection
  } catch {
    return undefined
  }
}

export async function writeCurrentSelection(paths: ClawctlPaths, selection: CurrentSelection): Promise<void> {
  await ensureBaseLayout(paths)
  await writeFile(paths.currentFile, JSON.stringify(selection, null, 2))
}

export async function clearCurrentSelection(paths: ClawctlPaths): Promise<void> {
  try {
    await unlink(paths.currentFile)
  } catch {
    return
  }
}

export async function ensureRuntimeLayout(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): Promise<void> {
  const homeDir = runtimeHomeDir(paths, implementation, version, backend)
  const workspaceDir = runtimeWorkspaceDir(paths, implementation, version, backend)
  const stateDir = runtimeStateDir(paths, implementation, version, backend)

  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ])
}

export async function installBinary(binaryPath: string): Promise<void> {
  await chmod(binaryPath, 0o755)
}

export async function removeInstall(paths: ClawctlPaths, record: InstallRecord): Promise<void> {
  await rm(installRoot(paths, record.implementation, record.resolvedVersion, record.backend), {
    recursive: true,
    force: true,
  })
}

export async function removeRuntime(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): Promise<void> {
  await rm(runtimeRoot(paths, implementation, version, backend), {
    recursive: true,
    force: true,
  })
}

export async function cleanupPartialInstallDirectories(
  paths: ClawctlPaths,
  implementation: string,
  backend = "local",
): Promise<number> {
  const parent = installParentDir(paths, implementation, backend)

  let entries: string[] = []
  try {
    entries = await readdir(parent)
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.includes(".partial-")) {
      continue
    }
    await rm(resolve(parent, entry), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

export async function cleanupOrphanedRuntimeDirectories(
  paths: ClawctlPaths,
  implementation: string,
  backend = "local",
): Promise<number> {
  const runtimeDir = runtimeImplementationDir(paths, implementation, backend)
  const installs = (await listInstallRecords(paths)).filter((record) => record.implementation === implementation)
  const allowed = new Set(installs.map((record) => basename(record.installRoot)))

  let entries: string[] = []
  try {
    entries = await readdir(runtimeDir)
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    if (allowed.has(entry)) {
      continue
    }
    await rm(runtimeRoot(paths, implementation, entry, backend), { recursive: true, force: true })
    removed += 1
  }
  return removed
}
