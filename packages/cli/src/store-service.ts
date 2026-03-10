import * as FileSystem from "@effect/platform/FileSystem"
import { Context, Effect, Layer } from "effect"

import type { CurrentSelection, InstallRecord, RuntimeRecord } from "./adapter/types.ts"
import { ensureClawctlDirectories } from "./directory-helpers.ts"
import { type ClawctlError, type ClawctlSystemError, userError, withSystemError } from "./errors.ts"
import { ClawctlPathsService } from "./paths-service.ts"
import {
  parseCurrentSelectionJson,
  parseInstallRecordJson,
  parseRuntimeRecordJson,
  stringifyCurrentSelectionJson,
  stringifyInstallRecordJson,
  stringifyRuntimeRecordJson,
} from "./record-schema.ts"
import {
  defaultSharedConfig,
  loadSharedConfig,
  parseSharedConfigEntries,
  type SharedConfig,
  stringifySharedConfigEntries,
} from "./shared-config.ts"

type ClawctlStoreApi = {
  readonly ensureSharedConfig: Effect.Effect<void, ClawctlSystemError>
  readonly readSharedConfig: Effect.Effect<SharedConfig, ClawctlError>
  readonly setSharedConfigValue: (key: string, value: string) => Effect.Effect<void, ClawctlSystemError>
  readonly listInstallRecords: Effect.Effect<InstallRecord[], ClawctlSystemError>
  readonly resolveInstalledRecord: (
    implementation: string,
    version?: string,
    backend?: string,
  ) => Effect.Effect<InstallRecord, ClawctlError>
  readonly readCurrentSelection: Effect.Effect<CurrentSelection | undefined, ClawctlSystemError>
  readonly writeCurrentSelection: (selection: CurrentSelection) => Effect.Effect<void, ClawctlSystemError>
  readonly writeInstallRecord: (record: InstallRecord) => Effect.Effect<void, ClawctlSystemError>
  readonly readRuntimeRecord: (
    implementation: string,
    version: string,
    backend?: string,
  ) => Effect.Effect<RuntimeRecord | undefined, ClawctlSystemError>
  readonly writeRuntimeRecord: (record: RuntimeRecord) => Effect.Effect<void, ClawctlSystemError>
  readonly clearRuntimeRecord: (
    implementation: string,
    version: string,
    backend?: string,
  ) => Effect.Effect<void, ClawctlSystemError>
  readonly clearCurrentSelection: Effect.Effect<void, ClawctlSystemError>
  readonly cleanupPartialInstallDirectories: (
    implementation: string,
    backend?: string,
  ) => Effect.Effect<number, ClawctlSystemError>
  readonly removeInstall: (record: InstallRecord) => Effect.Effect<void, ClawctlSystemError>
  readonly removeRuntime: (
    implementation: string,
    version: string,
    backend?: string,
  ) => Effect.Effect<void, ClawctlSystemError>
  readonly cleanupOrphanedRuntimeDirectories: (
    implementation: string,
    backend?: string,
  ) => Effect.Effect<number, ClawctlSystemError>
}

export class ClawctlStoreService extends Context.Tag("@clawctl/cli/ClawctlStoreService")<
  ClawctlStoreService,
  ClawctlStoreApi
>() {}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

export const ClawctlStoreLive = Layer.effect(
  ClawctlStoreService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const {
      paths,
      path,
      installMetadataFile,
      installParentDir,
      installRoot,
      runtimeImplementationDir,
      runtimeMetadataFile,
      runtimeRoot,
    } = yield* ClawctlPathsService

    const ensureSharedConfig = Effect.gen(function* () {
      yield* ensureClawctlDirectories(fs, paths, "store.make", ["root", "config", "cache", "install", "runtime", "log"])
      const exists = yield* withSystemError("store.configExists", fs.exists(paths.sharedConfigFile))
      if (exists) {
        return
      }
      yield* withSystemError(
        "store.writeDefaultConfig",
        fs.writeFileString(paths.sharedConfigFile, stringifySharedConfigEntries({ ...defaultSharedConfig })),
      )
    })
    const readSharedConfig = withSystemError(
      "store.readSharedConfig",
      Effect.gen(function* () {
        yield* ensureSharedConfig
        const source = yield* fs.readFileString(paths.sharedConfigFile)
        return yield* loadSharedConfig(parseSharedConfigEntries(source))
      }),
    )
    const setSharedConfigValue = Effect.fn("ClawctlStoreService.setSharedConfigValue")(function* (
      key: string,
      value: string,
    ) {
      yield* ensureSharedConfig
      const source = yield* withSystemError("store.readSharedConfigFile", fs.readFileString(paths.sharedConfigFile))
      const next = parseSharedConfigEntries(source)
      next[key] = value
      yield* withSystemError(
        "store.setSharedConfigValue",
        fs.writeFileString(paths.sharedConfigFile, stringifySharedConfigEntries(next)),
      )
    })
    const listInstallRecords = withSystemError(
      "store.listInstallRecords",
      Effect.gen(function* () {
        yield* ensureClawctlDirectories(fs, paths, "store.make", ["root", "install"])
        const installRootExists = yield* fs.exists(paths.installDir)
        if (!installRootExists) {
          return [] as InstallRecord[]
        }
        const records: InstallRecord[] = []
        const backends = (yield* fs.readDirectory(paths.installDir)).sort((left, right) => left.localeCompare(right))

        for (const backend of backends) {
          const backendRoot = `${paths.installDir}/${backend}`
          const backendExists = yield* fs.exists(backendRoot)
          if (!backendExists) {
            continue
          }
          const implementations = (yield* fs.readDirectory(backendRoot)).sort((left, right) =>
            left.localeCompare(right),
          )
          for (const implementation of implementations) {
            const versionDir = installParentDir(implementation, backend)
            const versionExists = yield* fs.exists(versionDir)
            if (!versionExists) {
              continue
            }
            const versions = yield* fs.readDirectory(versionDir)
            for (const version of versions) {
              const metadataFile = installMetadataFile(implementation, version, backend)
              const exists = yield* fs.exists(metadataFile)
              if (!exists) {
                continue
              }
              const source = yield* fs.readFileString(metadataFile)
              records.push(parseInstallRecordJson(source) as InstallRecord)
            }
          }
        }

        return records.sort((left, right) => {
          if (left.implementation === right.implementation) {
            return compareVersions(left.resolvedVersion, right.resolvedVersion)
          }
          return left.implementation.localeCompare(right.implementation)
        })
      }),
    )
    const resolveInstalledRecord = Effect.fn("ClawctlStoreService.resolveInstalledRecord")(function* (
      implementation: string,
      version?: string,
      backend?: string,
    ) {
      const records = (yield* listInstallRecords).filter(
        (record) => record.implementation === implementation && (backend === undefined || record.backend === backend),
      )
      if (records.length === 0) {
        const backendSuffix = backend ? ` for ${backend}` : ""
        return yield* userError(
          "store.resolveInstalledRecord",
          `implementation is not installed${backendSuffix}: ${implementation}`,
        )
      }
      if (version) {
        const matches = records.filter(
          (record) => record.resolvedVersion === version || record.requestedVersion === version,
        )
        if (matches.length === 0) {
          return yield* userError(
            "store.resolveInstalledRecord",
            `version is not installed: ${implementation}@${version}`,
          )
        }
        if (matches.length > 1 && backend === undefined) {
          return yield* userError(
            "store.resolveInstalledRecord",
            `version is installed for multiple backends: ${implementation}@${version}`,
          )
        }
        const [match] = matches
        if (!match) {
          return yield* userError(
            "store.resolveInstalledRecord",
            `version is not installed: ${implementation}@${version}`,
          )
        }
        return match
      }

      const distinctBackends = [...new Set(records.map((record) => record.backend))]
      if (distinctBackends.length > 1 && backend === undefined) {
        return yield* userError(
          "store.resolveInstalledRecord",
          `multiple backends are installed for ${implementation}; specify a runtime backend`,
        )
      }
      const [latest] = [...records].sort((left, right) => compareVersions(right.resolvedVersion, left.resolvedVersion))
      if (!latest) {
        return yield* userError("store.resolveInstalledRecord", `implementation is not installed: ${implementation}`)
      }
      return latest
    })
    const readCurrentSelection = withSystemError(
      "store.readCurrentSelection",
      Effect.gen(function* () {
        const exists = yield* fs.exists(paths.currentFile)
        if (!exists) {
          return undefined
        }
        const source = yield* fs.readFileString(paths.currentFile)
        return yield* Effect.try({
          try: () => parseCurrentSelectionJson(source) as CurrentSelection,
          catch: () => "parse-failed" as const,
        }).pipe(Effect.orElseSucceed(() => undefined))
      }),
    )
    const writeCurrentSelection = Effect.fn("ClawctlStoreService.writeCurrentSelection")(function* (
      selection: CurrentSelection,
    ) {
      yield* ensureClawctlDirectories(fs, paths, "store.make", ["root", "config"])
      yield* withSystemError(
        "store.writeCurrentSelection",
        fs.writeFileString(paths.currentFile, stringifyCurrentSelectionJson(selection)),
      )
    })
    const writeInstallRecord = Effect.fn("ClawctlStoreService.writeInstallRecord")(function* (record: InstallRecord) {
      const root = installRoot(record.implementation, record.resolvedVersion, record.backend)
      yield* withSystemError("store.makeInstallRoot", fs.makeDirectory(root, { recursive: true }))
      yield* withSystemError(
        "store.writeInstallRecord",
        fs.writeFileString(
          installMetadataFile(record.implementation, record.resolvedVersion, record.backend),
          stringifyInstallRecordJson(record),
        ),
      )
    })
    const readRuntimeRecord = Effect.fn("ClawctlStoreService.readRuntimeRecord")(function* (
      implementation: string,
      version: string,
      backend = "local",
    ) {
      const file = runtimeMetadataFile(implementation, version, backend)
      const exists = yield* withSystemError("store.runtimeRecordExists", fs.exists(file))
      if (!exists) {
        return undefined
      }
      const source = yield* withSystemError("store.readRuntimeRecord", fs.readFileString(file))
      return yield* Effect.try({
        try: () => parseRuntimeRecordJson(source) as RuntimeRecord,
        catch: () => "parse-failed" as const,
      }).pipe(Effect.orElseSucceed(() => undefined))
    })
    const writeRuntimeRecord = Effect.fn("ClawctlStoreService.writeRuntimeRecord")(function* (record: RuntimeRecord) {
      const root = runtimeRoot(record.implementation, record.version, record.backend)
      yield* withSystemError("store.makeRuntimeRoot", fs.makeDirectory(root, { recursive: true }))
      yield* withSystemError(
        "store.writeRuntimeRecord",
        fs.writeFileString(
          runtimeMetadataFile(record.implementation, record.version, record.backend),
          stringifyRuntimeRecordJson(record),
        ),
      )
    })
    const clearRuntimeRecord = Effect.fn("ClawctlStoreService.clearRuntimeRecord")(function* (
      implementation: string,
      version: string,
      backend = "local",
    ) {
      const file = runtimeMetadataFile(implementation, version, backend)
      const exists = yield* withSystemError("store.runtimeRecordExists", fs.exists(file))
      if (!exists) {
        return
      }
      yield* withSystemError("store.clearRuntimeRecord", fs.remove(file, { force: true }))
    })
    const clearCurrentSelection = withSystemError(
      "store.clearCurrentSelection",
      Effect.gen(function* () {
        const exists = yield* fs.exists(paths.currentFile)
        if (!exists) {
          return
        }
        yield* fs.remove(paths.currentFile)
      }),
    )
    const cleanupPartialInstallDirectories = Effect.fn("ClawctlStoreService.cleanupPartialInstallDirectories")(
      function* (implementation: string, backend = "local") {
        const parent = installParentDir(implementation, backend)
        const exists = yield* withSystemError("store.partialParentExists", fs.exists(parent))
        if (!exists) {
          return 0
        }

        const entries = yield* withSystemError("store.readInstallParent", fs.readDirectory(parent))
        let removed = 0
        for (const entry of entries) {
          if (!entry.includes(".partial-")) {
            continue
          }
          yield* withSystemError(
            "store.removePartialInstall",
            fs.remove(`${parent}/${entry}`, {
              recursive: true,
              force: true,
            }),
          )
          removed += 1
        }
        return removed
      },
    )
    const removeInstall = Effect.fn("ClawctlStoreService.removeInstall")(function* (record: InstallRecord) {
      yield* withSystemError(
        "store.removeInstall",
        fs.remove(installRoot(record.implementation, record.resolvedVersion, record.backend), {
          recursive: true,
          force: true,
        }),
      )
    })
    const removeRuntime = Effect.fn("ClawctlStoreService.removeRuntime")(function* (
      implementation: string,
      version: string,
      backend?: string,
    ) {
      yield* withSystemError(
        "store.removeRuntime",
        fs.remove(runtimeRoot(implementation, version, backend), {
          recursive: true,
          force: true,
        }),
      )
    })
    const cleanupOrphanedRuntimeDirectories = Effect.fn("ClawctlStoreService.cleanupOrphanedRuntimeDirectories")(
      function* (implementation: string, backend?: string) {
        const runtimeDir = runtimeImplementationDir(implementation, backend)
        const exists = yield* withSystemError("store.runtimeDirExists", fs.exists(runtimeDir))
        if (!exists) {
          return 0
        }

        const installs = (yield* listInstallRecords).filter((record) => record.implementation === implementation)
        const allowed = new Set(installs.map((record) => path.basename(record.installRoot) || record.resolvedVersion))
        const entries = yield* withSystemError("store.readRuntimeDirectory", fs.readDirectory(runtimeDir))
        let removed = 0

        for (const entry of entries) {
          if (allowed.has(entry)) {
            continue
          }
          yield* withSystemError(
            "store.removeOrphanedRuntime",
            fs.remove(runtimeRoot(implementation, entry, backend), {
              recursive: true,
              force: true,
            }),
          )
          removed += 1
        }
        return removed
      },
    )

    return ClawctlStoreService.of({
      ensureSharedConfig,
      readSharedConfig,
      setSharedConfigValue,
      listInstallRecords,
      resolveInstalledRecord,
      readCurrentSelection,
      writeCurrentSelection,
      writeInstallRecord,
      readRuntimeRecord,
      writeRuntimeRecord,
      clearRuntimeRecord,
      clearCurrentSelection,
      cleanupPartialInstallDirectories,
      removeInstall,
      removeRuntime,
      cleanupOrphanedRuntimeDirectories,
    })
  }),
)
