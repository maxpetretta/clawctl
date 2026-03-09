import { mkdir, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"

export type ClawctlPaths = {
  rootDir: string
  configDir: string
  cacheDir: string
  installDir: string
  runtimeDir: string
  logDir: string
  sharedConfigFile: string
  currentFile: string
}

export function resolvePaths(rootOverride = process.env.CLAWCTL_ROOT ?? process.env.CLAWCTL_STATE_DIR): ClawctlPaths {
  const rootDir = rootOverride ?? resolve(homedir(), ".clawctl")

  return {
    rootDir,
    configDir: resolve(rootDir, "config"),
    cacheDir: resolve(rootDir, "cache"),
    installDir: resolve(rootDir, "installs"),
    runtimeDir: resolve(rootDir, "runtimes"),
    logDir: resolve(rootDir, "logs"),
    sharedConfigFile: resolve(rootDir, "config", "shared.env"),
    currentFile: resolve(rootDir, "config", "current.json"),
  }
}

export function installRoot(paths: ClawctlPaths, implementation: string, version: string, backend = "local"): string {
  return resolve(paths.installDir, backend, implementation, version)
}

export function installParentDir(paths: ClawctlPaths, implementation: string, backend = "local"): string {
  return resolve(paths.installDir, backend, implementation)
}

export function partialInstallRoot(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  token: string,
  backend = "local",
): string {
  return resolve(installParentDir(paths, implementation, backend), `${version}.partial-${token}`)
}

export function installMetadataFile(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): string {
  return resolve(installRoot(paths, implementation, version, backend), "install.json")
}

export function runtimeRoot(paths: ClawctlPaths, implementation: string, version: string, backend = "local"): string {
  return resolve(paths.runtimeDir, backend, implementation, version)
}

export function runtimeImplementationDir(paths: ClawctlPaths, implementation: string, backend = "local"): string {
  return resolve(paths.runtimeDir, backend, implementation)
}

export function runtimeHomeDir(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): string {
  return resolve(runtimeRoot(paths, implementation, version, backend), "home")
}

export function runtimeWorkspaceDir(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): string {
  return resolve(runtimeRoot(paths, implementation, version, backend), "workspace")
}

export function runtimeStateDir(
  paths: ClawctlPaths,
  implementation: string,
  version: string,
  backend = "local",
): string {
  return resolve(runtimeRoot(paths, implementation, version, backend), "state")
}

export async function ensureBaseLayout(paths: ClawctlPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.rootDir, { recursive: true }),
    mkdir(paths.configDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(paths.installDir, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.logDir, { recursive: true }),
  ])
}

export async function listInstalledImplementationDirs(paths: ClawctlPaths): Promise<string[]> {
  try {
    return (await readdir(resolve(paths.installDir, "local"))).sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}
