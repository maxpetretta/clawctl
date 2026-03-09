import type * as FileSystem from "@effect/platform/FileSystem"
import { Effect } from "effect"

import { type ClawctlSystemError, withSystemError } from "./errors.ts"
import type { ClawctlPaths } from "./paths-service.ts"

type ManagedDirectory = "cache" | "config" | "install" | "log" | "root" | "runtime"

const directoryDetails = {
  cache: {
    actionSuffix: "CacheDir",
    resolvePath: (paths: ClawctlPaths) => paths.cacheDir,
  },
  config: {
    actionSuffix: "ConfigDir",
    resolvePath: (paths: ClawctlPaths) => paths.configDir,
  },
  install: {
    actionSuffix: "InstallDir",
    resolvePath: (paths: ClawctlPaths) => paths.installDir,
  },
  log: {
    actionSuffix: "LogDir",
    resolvePath: (paths: ClawctlPaths) => paths.logDir,
  },
  root: {
    actionSuffix: "RootDir",
    resolvePath: (paths: ClawctlPaths) => paths.rootDir,
  },
  runtime: {
    actionSuffix: "RuntimeDir",
    resolvePath: (paths: ClawctlPaths) => paths.runtimeDir,
  },
} as const satisfies Record<
  ManagedDirectory,
  {
    actionSuffix: string
    resolvePath: (paths: ClawctlPaths) => string
  }
>

export function ensureClawctlDirectories(
  fs: FileSystem.FileSystem,
  paths: ClawctlPaths,
  actionPrefix: string,
  directories: ReadonlyArray<ManagedDirectory>,
): Effect.Effect<void, ClawctlSystemError> {
  return Effect.forEach(
    directories,
    (directory) =>
      withSystemError(
        `${actionPrefix}${directoryDetails[directory].actionSuffix}`,
        fs.makeDirectory(directoryDetails[directory].resolvePath(paths), { recursive: true }),
      ),
    { discard: true },
  )
}
