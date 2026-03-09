import { homedir } from "node:os"

import * as PlatformPath from "@effect/platform/Path"
import { Context, Effect, Layer } from "effect"

export type ClawctlPaths = {
  readonly rootDir: string
  readonly configDir: string
  readonly cacheDir: string
  readonly installDir: string
  readonly runtimeDir: string
  readonly logDir: string
  readonly sharedConfigFile: string
  readonly currentFile: string
}

type ClawctlPathsApi = {
  readonly paths: ClawctlPaths
  readonly path: PlatformPath.Path
  readonly installRoot: (implementation: string, version: string, backend?: string) => string
  readonly installParentDir: (implementation: string, backend?: string) => string
  readonly partialInstallRoot: (implementation: string, version: string, token: string, backend?: string) => string
  readonly installMetadataFile: (implementation: string, version: string, backend?: string) => string
  readonly runtimeRoot: (implementation: string, version: string, backend?: string) => string
  readonly runtimeImplementationDir: (implementation: string, backend?: string) => string
  readonly runtimeHomeDir: (implementation: string, version: string, backend?: string) => string
  readonly runtimeWorkspaceDir: (implementation: string, version: string, backend?: string) => string
  readonly runtimeStateDir: (implementation: string, version: string, backend?: string) => string
  readonly runtimeMetadataFile: (implementation: string, version: string, backend?: string) => string
  readonly runtimeLogFile: (implementation: string, version: string, backend?: string) => string
}

export class ClawctlPathsService extends Context.Tag("@clawctl/cli/ClawctlPathsService")<
  ClawctlPathsService,
  ClawctlPathsApi
>() {}

function makeClawctlPathsApi(path: PlatformPath.Path, rootDir: string): ClawctlPathsApi {
  const paths: ClawctlPaths = {
    rootDir,
    configDir: path.resolve(rootDir, "config"),
    cacheDir: path.resolve(rootDir, "cache"),
    installDir: path.resolve(rootDir, "installs"),
    runtimeDir: path.resolve(rootDir, "runtimes"),
    logDir: path.resolve(rootDir, "logs"),
    sharedConfigFile: path.resolve(rootDir, "config", "shared.env"),
    currentFile: path.resolve(rootDir, "config", "current.json"),
  }

  const installParentDir = (implementation: string, backend = "local") =>
    path.resolve(paths.installDir, backend, implementation)
  const installRoot = (implementation: string, version: string, backend = "local") =>
    path.resolve(installParentDir(implementation, backend), version)
  const partialInstallRoot = (implementation: string, version: string, token: string, backend = "local") =>
    path.resolve(installParentDir(implementation, backend), `${version}.partial-${token}`)
  const installMetadataFile = (implementation: string, version: string, backend = "local") =>
    path.resolve(installRoot(implementation, version, backend), "install.json")
  const runtimeImplementationDir = (implementation: string, backend = "local") =>
    path.resolve(paths.runtimeDir, backend, implementation)
  const runtimeRoot = (implementation: string, version: string, backend = "local") =>
    path.resolve(runtimeImplementationDir(implementation, backend), version)
  const runtimeHomeDir = (implementation: string, version: string, backend = "local") =>
    path.resolve(runtimeRoot(implementation, version, backend), "home")
  const runtimeWorkspaceDir = (implementation: string, version: string, backend = "local") =>
    path.resolve(runtimeRoot(implementation, version, backend), "workspace")
  const runtimeStateDir = (implementation: string, version: string, backend = "local") =>
    path.resolve(runtimeRoot(implementation, version, backend), "state")
  const runtimeMetadataFile = (implementation: string, version: string, backend = "local") =>
    path.resolve(runtimeRoot(implementation, version, backend), "runtime.json")
  const runtimeLogFile = (implementation: string, version: string, backend = "local") =>
    path.resolve(runtimeRoot(implementation, version, backend), "service.log")

  return {
    paths,
    path,
    installRoot,
    installParentDir,
    partialInstallRoot,
    installMetadataFile,
    runtimeRoot,
    runtimeImplementationDir,
    runtimeHomeDir,
    runtimeWorkspaceDir,
    runtimeStateDir,
    runtimeMetadataFile,
    runtimeLogFile,
  }
}

export function makeClawctlPathsLayer(rootDir: string) {
  return Layer.effect(
    ClawctlPathsService,
    Effect.gen(function* () {
      const path = yield* PlatformPath.Path
      return ClawctlPathsService.of(makeClawctlPathsApi(path, rootDir))
    }),
  )
}

export const ClawctlPathsLive = Layer.effect(
  ClawctlPathsService,
  Effect.gen(function* () {
    const path = yield* PlatformPath.Path
    const rootDir = process.env.CLAWCTL_ROOT ?? process.env.CLAWCTL_STATE_DIR ?? path.resolve(homedir(), ".clawctl")
    return ClawctlPathsService.of(makeClawctlPathsApi(path, rootDir))
  }),
)
