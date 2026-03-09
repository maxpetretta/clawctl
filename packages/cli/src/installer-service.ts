import { createHash } from "node:crypto"

import * as Command from "@effect/platform/Command"
import * as CommandExecutor from "@effect/platform/CommandExecutor"
import * as FileSystem from "@effect/platform/FileSystem"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as HttpClientResponse from "@effect/platform/HttpClientResponse"
import { Context, Effect, Layer } from "effect"
import * as Schema from "effect/Schema"

import { getRegisteredImplementation } from "./adapter/registry.ts"
import type {
  GithubReleaseInstallManifest,
  InstallManifest,
  NpmPackageInstallManifest,
  PythonPackageInstallManifest,
  RepoBootstrapInstallManifest,
  VersionSourceManifest,
} from "./adapter/schema.ts"
import type { InstallRecord } from "./adapter/types.ts"
import { type ClawctlError, type ClawctlSystemError, userError, withSystemError } from "./errors.ts"
import { ClawctlPathsService } from "./paths-service.ts"
import { requireV1HostPlatform } from "./platform.ts"
import { ClawctlStoreService } from "./store-service.ts"
import { gitExecutable, npmExecutable, uvExecutable } from "./tooling.ts"

type ClawctlInstallerApi = {
  readonly installImplementation: (
    implementation: string,
    version?: string,
  ) => Effect.Effect<InstallRecord, ClawctlError>
  readonly listRemoteVersions: (implementation: string) => Effect.Effect<ReadonlyArray<string>, ClawctlError>
}

export class ClawctlInstallerService extends Context.Tag("@clawctl/cli/ClawctlInstallerService")<
  ClawctlInstallerService,
  ClawctlInstallerApi
>() {}

const GithubReleaseResponseSchema = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser_download_url: Schema.String,
    }),
  ),
})

const GithubReleaseListSchema = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
  }),
)

const PypiPackageResponseSchema = Schema.Struct({
  info: Schema.Struct({
    version: Schema.String,
  }),
  releases: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})

const JsonStringSchema = Schema.parseJson(Schema.String)

export function rewritePythonScriptShebang(source: string, fromInterpreterDir: string, toInterpreterDir: string) {
  const fromPrefix = `#!${fromInterpreterDir}/`
  if (!source.startsWith(fromPrefix)) {
    return source
  }
  return `#!${toInterpreterDir}/${source.slice(fromPrefix.length)}`
}

export function repairPythonScriptShebang(source: string, installedInterpreterDir: string) {
  const newlineIndex = source.indexOf("\n")
  const firstLine = newlineIndex === -1 ? source : source.slice(0, newlineIndex)
  if (!firstLine.startsWith("#!")) {
    return source
  }

  const currentInterpreter = firstLine.slice(2)
  const marker = "/venv/bin/"
  const markerIndex = currentInterpreter.lastIndexOf(marker)
  if (markerIndex === -1) {
    return source
  }

  const interpreterName = currentInterpreter.slice(markerIndex + marker.length)
  if (interpreterName.length === 0) {
    return source
  }

  const repairedFirstLine = `#!${installedInterpreterDir}/${interpreterName}`
  if (firstLine === repairedFirstLine) {
    return source
  }
  return `${repairedFirstLine}${source.slice(firstLine.length)}`
}

function rewriteInstallRootPaths(paths: ReadonlyArray<string>, fromRoot: string, toRoot: string): string[] {
  const normalizedFromRoot = fromRoot.endsWith("/") ? fromRoot : `${fromRoot}/`
  return paths.map((entry) => {
    if (entry === fromRoot) {
      return toRoot
    }
    if (entry.startsWith(normalizedFromRoot)) {
      return `${toRoot}${entry.slice(fromRoot.length)}`
    }
    return entry
  })
}

function githubApiOrigin(): string {
  return process.env.CLAWCTL_GITHUB_API_ORIGIN?.replace(/\/+$/u, "") ?? "https://api.github.com"
}

function pypiApiOrigin(): string {
  return process.env.CLAWCTL_PYPI_API_ORIGIN?.replace(/\/+$/u, "") ?? "https://pypi.org"
}

function stageToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function createInstallRecord(
  implementationId: string,
  supportTier: InstallRecord["supportTier"],
  input: Omit<InstallRecord, "implementation" | "installedAt" | "supportTier">,
): InstallRecord {
  return {
    implementation: implementationId,
    ...input,
    installedAt: new Date().toISOString(),
    supportTier,
  }
}

export const ClawctlInstallerLive = Layer.effect(
  ClawctlInstallerService,
  Effect.gen(function* () {
    const commandExecutor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const httpClient = yield* HttpClient.HttpClient
    const { installParentDir, installRoot, partialInstallRoot, path, paths } = yield* ClawctlPathsService
    const store = yield* ClawctlStoreService
    const resolveRegistration = Effect.fn("ClawctlInstallerService.resolveRegistration")(function* (
      implementation: string,
    ) {
      return yield* Effect.try({
        try: () => getRegisteredImplementation(implementation),
        catch: (cause) =>
          userError("installer.resolveRegistration", cause instanceof Error ? cause.message : String(cause)),
      })
    })
    const requireHostPlatform = Effect.fn("ClawctlInstallerService.requireHostPlatform")(function* () {
      return yield* Effect.try({
        try: () => requireV1HostPlatform(),
        catch: (cause) =>
          userError("installer.requireHostPlatform", cause instanceof Error ? cause.message : String(cause)),
      })
    })

    const requestJson = <A, I, R>(
      action: string,
      url: string,
      schema: Schema.Schema<A, I, R>,
    ): Effect.Effect<A, ClawctlSystemError, R> =>
      Effect.gen(function* () {
        const request = HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("User-Agent", "clawctl"),
          HttpClientRequest.acceptJson,
        )
        const response = yield* withSystemError(action, httpClient.execute(request))
        const ok = yield* withSystemError(`${action}.status`, HttpClientResponse.filterStatusOk(response))
        const json = yield* withSystemError(`${action}.json`, ok.json)
        return yield* withSystemError(`${action}.decode`, Schema.decodeUnknown(schema)(json))
      })

    const downloadBytes = Effect.fn("ClawctlInstallerService.downloadBytes")(function* (action: string, url: string) {
      const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("User-Agent", "clawctl"))
      const response = yield* withSystemError(action, httpClient.execute(request))
      const ok = yield* withSystemError(`${action}.status`, HttpClientResponse.filterStatusOk(response))
      const arrayBuffer = yield* withSystemError(`${action}.body`, ok.arrayBuffer)
      return new Uint8Array(arrayBuffer)
    })

    const runCommand = Effect.fn("ClawctlInstallerService.runCommand")(function* (
      action: string,
      file: string,
      args: ReadonlyArray<string>,
      options?: {
        cwd?: string
        env?: NodeJS.ProcessEnv
      },
    ) {
      let command = Command.make(file, ...args)
      if (options?.env) {
        command = command.pipe(Command.env(options.env))
      }
      if (options?.cwd) {
        command = command.pipe(Command.workingDirectory(options.cwd))
      }
      return yield* withSystemError(action, commandExecutor.string(command))
    })

    const parseJsonString = Effect.fn("ClawctlInstallerService.parseJsonString")(function* (
      action: string,
      source: string,
    ) {
      return yield* withSystemError(action, Schema.decodeUnknown(JsonStringSchema)(source))
    })

    const selectAsset = Effect.fn("ClawctlInstallerService.selectAsset")(function* (
      manifest: GithubReleaseInstallManifest,
      assets: ReadonlyArray<{
        name: string
        browser_download_url: string
      }>,
    ) {
      const host = yield* requireHostPlatform()
      const rule = manifest.assetRules.find(
        (candidate) => candidate.match.os === host.os && candidate.match.arch === host.arch,
      )
      if (!rule) {
        return yield* userError(
          "installer.selectAsset",
          `no asset rule for ${manifest.repository} on ${host.os}-${host.arch}`,
        )
      }

      const asset = assets.find((candidate) => candidate.name === rule.pattern)
      if (!asset) {
        return yield* userError(
          "installer.selectAsset",
          `release asset not found for ${manifest.repository}: ${rule.pattern}`,
        )
      }

      return { asset, host, rule }
    })

    const verifyChecksum = Effect.fn("ClawctlInstallerService.verifyChecksum")(function* (
      manifest: GithubReleaseInstallManifest,
      assets: ReadonlyArray<{
        name: string
        browser_download_url: string
      }>,
      assetName: string,
      assetPath: string,
      cacheDir: string,
    ) {
      const verification = manifest.verification
      if (!verification || verification.kind === "none") {
        return undefined
      }

      if (verification.kind !== "checksum-file") {
        return `verification skipped: ${verification.kind}`
      }

      const checksumAsset = assets.find((candidate) => candidate.name === verification.assetPattern)
      if (!checksumAsset) {
        return "verification metadata missing"
      }

      const checksumPath = path.resolve(cacheDir, verification.assetPattern)
      const checksumBytes = yield* downloadBytes("installer.downloadChecksum", checksumAsset.browser_download_url)
      yield* withSystemError("installer.writeChecksum", fs.writeFile(checksumPath, checksumBytes))

      const source = yield* withSystemError("installer.readChecksum", fs.readFileString(checksumPath))
      const line = source
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find((entry) => entry.includes(assetName))

      if (!line) {
        return "verification metadata missing matching asset"
      }

      const [expected] = line.split(/\s+/u)
      if (!expected) {
        return "verification metadata malformed"
      }

      const bytes = yield* withSystemError("installer.readDownloadedAsset", fs.readFile(assetPath))
      const actual = createHash("sha256").update(bytes).digest("hex")
      if (actual !== expected) {
        return yield* userError("installer.verifyChecksum", `checksum verification failed for ${assetName}`)
      }

      return `sha256:${actual}`
    })

    const materializeReleaseBinary = Effect.fn("ClawctlInstallerService.materializeReleaseBinary")(function* (
      assetPath: string,
      archiveKind: GithubReleaseInstallManifest["assetRules"][number]["archive"],
      destinationRoot: string,
      binaryName: string,
    ) {
      const binDir = path.resolve(destinationRoot, "bin")
      yield* withSystemError("installer.makeBinDir", fs.makeDirectory(binDir, { recursive: true }))
      const destination = path.resolve(binDir, binaryName)

      if (archiveKind.kind === "none") {
        yield* withSystemError("installer.moveBinary", fs.rename(assetPath, destination))
        yield* withSystemError("installer.chmodBinary", fs.chmod(destination, 0o755))
        return destination
      }

      const extractDir = path.resolve(destinationRoot, ".extract")
      yield* withSystemError("installer.makeExtractDir", fs.makeDirectory(extractDir, { recursive: true }))

      if (archiveKind.kind === "tar.gz") {
        yield* runCommand("installer.extractTarGz", "tar", ["-xzf", assetPath, "-C", extractDir])
      } else {
        yield* runCommand("installer.extractZip", "unzip", ["-o", assetPath, "-d", extractDir])
      }

      const preferredBinary = path.resolve(extractDir, archiveKind.binaryPath)
      const preferredExists = yield* withSystemError("installer.statExtractedBinary", fs.exists(preferredBinary))
      const extractedBinary = preferredExists
        ? preferredBinary
        : yield* Effect.gen(function* () {
            const entries = yield* withSystemError(
              "installer.readExtractDir",
              fs.readDirectory(extractDir, { recursive: true }),
            )
            const matches = entries
              .filter((entry) => path.basename(entry) === binaryName)
              .map((entry) => path.resolve(extractDir, entry))
            if (matches.length === 1) {
              const [match] = matches
              if (match) {
                return match
              }
            }
            if (matches.length === 0) {
              return yield* userError(
                "installer.materializeReleaseBinary",
                `release archive did not contain ${archiveKind.binaryPath} or a unique ${binaryName} binary`,
              )
            }
            return yield* userError(
              "installer.materializeReleaseBinary",
              `release archive contained multiple ${binaryName} binaries; adapter binaryPath must be explicit`,
            )
          })
      yield* withSystemError("installer.moveExtractedBinary", fs.rename(extractedBinary, destination))
      yield* withSystemError("installer.chmodExtractedBinary", fs.chmod(destination, 0o755))
      return destination
    })

    const finalizeInstall = Effect.fn("ClawctlInstallerService.finalizeInstall")(function* (
      stageRoot: string,
      implementationId: string,
      version: string,
    ) {
      const destinationRoot = installRoot(implementationId, version)
      yield* withSystemError(
        "installer.removeExistingInstall",
        fs.remove(destinationRoot, { recursive: true, force: true }),
      )
      yield* withSystemError("installer.finalizeInstall", fs.rename(stageRoot, destinationRoot))
      return destinationRoot
    })

    const rewriteInstalledPythonEntrypoints = Effect.fn(
      "ClawctlInstallerService.rewriteInstalledPythonEntrypoints",
    )(function* (stageRoot: string, installRootPath: string, entrypoint: string) {
      const stageInterpreterDir = path.resolve(stageRoot, "venv", "bin")
      const installedInterpreterDir = path.resolve(installRootPath, "venv", "bin")
      const scriptPaths = [
        path.resolve(installRootPath, "venv", "bin", entrypoint),
        path.resolve(installRootPath, "bin", entrypoint),
      ]

      for (const scriptPath of scriptPaths) {
        const exists = yield* withSystemError("installer.statPythonEntrypoint", fs.exists(scriptPath))
        if (!exists) {
          continue
        }
        const source = yield* withSystemError("installer.readPythonEntrypoint", fs.readFileString(scriptPath))
        const rewritten = rewritePythonScriptShebang(source, stageInterpreterDir, installedInterpreterDir)
        if (rewritten !== source) {
          yield* withSystemError("installer.writePythonEntrypoint", fs.writeFileString(scriptPath, rewritten))
          yield* withSystemError("installer.chmodPythonEntrypoint", fs.chmod(scriptPath, 0o755))
        }
      }
    })

    const resolveNpmVersion = Effect.fn("ClawctlInstallerService.resolveNpmVersion")(function* (
      strategy: NpmPackageInstallManifest,
      requestedVersion?: string,
    ) {
      if (requestedVersion) {
        return requestedVersion
      }

      const stdout = yield* runCommand(
        "installer.resolveNpmVersion",
        npmExecutable(),
        ["view", strategy.packageName, "version", "--json"],
        {
          env: process.env,
        },
      )
      const source = stdout.trim()
      if (source.length === 0) {
        return yield* userError(
          "installer.resolveNpmVersion",
          `failed to resolve npm version for ${strategy.packageName}`,
        )
      }
      return yield* parseJsonString("installer.parseNpmVersion", source)
    })

    const resolvePythonVersion = Effect.fn("ClawctlInstallerService.resolvePythonVersion")(function* (
      strategy: PythonPackageInstallManifest,
      requestedVersion?: string,
    ) {
      if (requestedVersion) {
        return requestedVersion
      }

      const response = yield* requestJson(
        "installer.resolvePythonVersion",
        `${pypiApiOrigin()}/pypi/${strategy.packageName}/json`,
        PypiPackageResponseSchema,
      )
      const version = response.info.version.trim()
      if (version.length === 0) {
        return yield* userError(
          "installer.resolvePythonVersion",
          `failed to resolve PyPI version for ${strategy.packageName}`,
        )
      }
      return version
    })

    const listVersionsFromSource = Effect.fn("ClawctlInstallerService.listVersionsFromSource")(function* (
      implementation: string,
      versionSource: VersionSourceManifest,
    ) {
      switch (versionSource.kind) {
        case "github-releases": {
          const releases = yield* requestJson(
            "installer.listGithubVersions",
            `${githubApiOrigin()}/repos/${versionSource.repository}/releases`,
            GithubReleaseListSchema,
          )
          return releases.map((release) => release.tag_name.trim()).filter((version) => version.length > 0)
        }
        case "npm": {
          const stdout = yield* runCommand(
            "installer.listNpmVersions",
            npmExecutable(),
            ["view", versionSource.packageName, "versions", "--json"],
            {
              env: process.env,
            },
          )
          const source = stdout.trim()
          if (source.length === 0) {
            return yield* userError(
              "installer.listNpmVersions",
              `failed to resolve npm versions for ${versionSource.packageName}`,
            )
          }
          const parsed = yield* withSystemError(
            "installer.parseNpmVersions",
            Schema.decodeUnknown(Schema.parseJson(Schema.Array(Schema.String)))(source),
          )
          return parsed.filter((version) => version.trim().length > 0)
        }
        case "pypi": {
          const response = yield* requestJson(
            "installer.listPythonVersions",
            `${pypiApiOrigin()}/pypi/${versionSource.packageName}/json`,
            PypiPackageResponseSchema,
          )
          return Object.keys(response.releases)
            .filter((version) => version.trim().length > 0)
            .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }))
        }
        case "static":
          return versionSource.versions
        case "git-tags": {
          const stdout = yield* runCommand(
            "installer.listGitTagVersions",
            gitExecutable(),
            ["ls-remote", "--tags", "--refs", versionSource.repository],
            {
              env: process.env,
            },
          )
          return stdout
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => line.split(/\s+/u)[1] ?? "")
            .filter((ref) => ref.startsWith("refs/tags/"))
            .map((ref) => ref.replace("refs/tags/", ""))
            .filter((version) => version.length > 0)
            .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }))
        }
        case "adapter-hook": {
          if (versionSource.hook !== "resolveVersions") {
            return yield* userError(
              "installer.listVersionsFromSource",
              `unsupported version hook: ${versionSource.hook}`,
            )
          }
          const registration = yield* resolveRegistration(implementation)
          const resolveVersions = registration.implementationHooks.resolveVersions
          if (!resolveVersions) {
            return yield* userError(
              "installer.listVersionsFromSource",
              `adapter does not implement resolveVersions: ${implementation}`,
            )
          }
          return yield* Effect.tryPromise({
            try: async () => [...(await resolveVersions())],
            catch: (cause) =>
              userError("installer.listVersionsFromSource", cause instanceof Error ? cause.message : String(cause)),
          }).pipe(Effect.map((versions) => versions.filter((version) => version.trim().length > 0)))
        }
      }
    })

    const resolveDefaultVersion = Effect.fn("ClawctlInstallerService.resolveDefaultVersion")(function* (
      implementation: string,
      versionSource: VersionSourceManifest,
    ) {
      const versions = yield* listVersionsFromSource(implementation, versionSource)
      const [first] = versions
      if (!first) {
        return yield* userError(
          "installer.resolveDefaultVersion",
          `no installable versions found for ${implementation}`,
        )
      }
      return first
    })

    const installGithubRelease = Effect.fn("ClawctlInstallerService.installGithubRelease")(function* (
      implementationId: string,
      supportTier: InstallRecord["supportTier"],
      strategy: GithubReleaseInstallManifest,
      requestedVersion?: string,
    ) {
      const releaseUrl = requestedVersion
        ? `${githubApiOrigin()}/repos/${strategy.repository}/releases/tags/${requestedVersion}`
        : `${githubApiOrigin()}/repos/${strategy.repository}/releases/latest`
      const release = yield* requestJson("installer.fetchGithubRelease", releaseUrl, GithubReleaseResponseSchema)
      const { asset, host, rule } = yield* selectAsset(strategy, release.assets)
      const resolvedVersion = release.tag_name
      const stageRoot = partialInstallRoot(implementationId, resolvedVersion, stageToken())
      const cacheDir = path.resolve(paths.cacheDir, "downloads", implementationId, resolvedVersion)
      yield* withSystemError("installer.makeCacheDir", fs.makeDirectory(cacheDir, { recursive: true }))
      yield* withSystemError("installer.makeStageDir", fs.makeDirectory(stageRoot, { recursive: true }))

      const assetPath = path.resolve(cacheDir, asset.name)
      const assetBytes = yield* downloadBytes("installer.downloadReleaseAsset", asset.browser_download_url)
      yield* withSystemError("installer.writeReleaseAsset", fs.writeFile(assetPath, assetBytes))
      const verificationSummary = yield* verifyChecksum(strategy, release.assets, asset.name, assetPath, cacheDir)
      yield* materializeReleaseBinary(assetPath, rule.archive, stageRoot, implementationId)
      const installRootPath = yield* finalizeInstall(stageRoot, implementationId, resolvedVersion)

      return createInstallRecord(implementationId, supportTier, {
        backend: "local",
        entrypointCommand: [path.resolve(installRootPath, "bin", implementationId)],
        installRoot: installRootPath,
        installStrategy: strategy.strategy,
        platform: host,
        requestedVersion: requestedVersion ?? "latest",
        resolvedVersion,
        sourceReference: strategy.repository,
        verificationSummary,
      })
    })

    const installNpmPackage = Effect.fn("ClawctlInstallerService.installNpmPackage")(function* (
      implementationId: string,
      supportTier: InstallRecord["supportTier"],
      strategy: NpmPackageInstallManifest,
      requestedVersion?: string,
    ) {
      const resolvedVersion = yield* resolveNpmVersion(strategy, requestedVersion)
      const stageRoot = partialInstallRoot(implementationId, resolvedVersion, stageToken())
      yield* withSystemError("installer.makeStageDir", fs.makeDirectory(stageRoot, { recursive: true }))
      yield* withSystemError(
        "installer.writeNpmPackageJson",
        fs.writeFileString(
          path.resolve(stageRoot, "package.json"),
          `{
  "name": "clawctl-${implementationId}",
  "private": true
}
`,
        ),
      )

      yield* runCommand(
        "installer.installNpmPackage",
        npmExecutable(),
        ["install", "--prefix", stageRoot, "--no-save", `${strategy.packageName}@${resolvedVersion}`],
        { env: process.env },
      )

      const binaryPath = path.resolve(stageRoot, "node_modules", ".bin", strategy.binName)
      yield* withSystemError("installer.checkNpmBinary", fs.access(binaryPath))
      const installRootPath = yield* finalizeInstall(stageRoot, implementationId, resolvedVersion)
      const hostPlatform = yield* requireHostPlatform()

      return createInstallRecord(implementationId, supportTier, {
        backend: "local",
        entrypointCommand: [path.resolve(installRootPath, "node_modules", ".bin", strategy.binName)],
        installRoot: installRootPath,
        installStrategy: strategy.strategy,
        platform: hostPlatform,
        requestedVersion: requestedVersion ?? "latest",
        resolvedVersion,
        sourceReference: strategy.packageName,
        verificationSummary: "registry-managed",
      })
    })

    const installPythonPackage = Effect.fn("ClawctlInstallerService.installPythonPackage")(function* (
      implementationId: string,
      supportTier: InstallRecord["supportTier"],
      strategy: PythonPackageInstallManifest,
      requestedVersion?: string,
    ) {
      if (strategy.installer !== "uv-tool") {
        return yield* userError(
          "installer.installPythonPackage",
          `python installer is not implemented yet: ${strategy.installer}`,
        )
      }

      const resolvedVersion = yield* resolvePythonVersion(strategy, requestedVersion)
      const stageRoot = partialInstallRoot(implementationId, resolvedVersion, stageToken())
      const venvRoot = path.resolve(stageRoot, "venv")
      const venvPython = path.resolve(venvRoot, "bin", "python")
      const stageBinDir = path.resolve(stageRoot, "bin")
      const stageEntrypoint = path.resolve(stageBinDir, strategy.entrypoint)
      yield* withSystemError("installer.makeStageDir", fs.makeDirectory(stageRoot, { recursive: true }))

      yield* runCommand("installer.createPythonVenv", uvExecutable(), ["venv", venvRoot], { env: process.env })

      yield* runCommand(
        "installer.installPythonPackage",
        uvExecutable(),
        ["pip", "install", "--python", venvPython, `${strategy.packageName}==${resolvedVersion}`],
        { env: process.env },
      )

      const binaryPath = path.resolve(venvRoot, "bin", strategy.entrypoint)
      yield* withSystemError("installer.checkPythonBinary", fs.access(binaryPath))
      yield* withSystemError("installer.makePythonBinDir", fs.makeDirectory(stageBinDir, { recursive: true }))
      yield* withSystemError("installer.linkPythonBinary", fs.copyFile(binaryPath, stageEntrypoint))
      yield* withSystemError("installer.checkLinkedPythonBinary", fs.access(stageEntrypoint))
      const installRootPath = yield* finalizeInstall(stageRoot, implementationId, resolvedVersion)
      yield* rewriteInstalledPythonEntrypoints(stageRoot, installRootPath, strategy.entrypoint)
      const hostPlatform = yield* requireHostPlatform()

      return createInstallRecord(implementationId, supportTier, {
        backend: "local",
        entrypointCommand: [path.resolve(installRootPath, "bin", strategy.entrypoint)],
        installRoot: installRootPath,
        installStrategy: strategy.strategy,
        platform: hostPlatform,
        requestedVersion: requestedVersion ?? "latest",
        resolvedVersion,
        sourceReference: strategy.packageName,
        verificationSummary: "registry-managed",
      })
    })

    const installRepoBootstrap = Effect.fn("ClawctlInstallerService.installRepoBootstrap")(function* (
      implementationId: string,
      supportTier: InstallRecord["supportTier"],
      strategy: RepoBootstrapInstallManifest,
      requestedVersion?: string,
    ) {
      const registration = yield* resolveRegistration(implementationId)
      const resolvedVersion =
        requestedVersion ?? (yield* resolveDefaultVersion(implementationId, strategy.versionSource))
      const stageRoot = partialInstallRoot(implementationId, resolvedVersion, stageToken())
      const repoDir = path.resolve(stageRoot, "repo")
      yield* withSystemError("installer.makeStageDir", fs.makeDirectory(stageRoot, { recursive: true }))

      if (strategy.refPolicy === "commit") {
        yield* runCommand("installer.cloneRepository", gitExecutable(), ["clone", strategy.repository, repoDir], {
          env: process.env,
        })
        yield* runCommand(
          "installer.checkoutRepository",
          gitExecutable(),
          ["-C", repoDir, "checkout", resolvedVersion],
          {
            env: process.env,
          },
        )
      } else {
        yield* runCommand(
          "installer.cloneRepositoryBranch",
          gitExecutable(),
          ["clone", "--depth", "1", "--branch", resolvedVersion, strategy.repository, repoDir],
          { env: process.env },
        )
      }

      const entrypointCommand =
        strategy.bootstrapHook === "install" && registration.implementationHooks.install
          ? (yield* Effect.tryPromise({
              try: () =>
                registration.implementationHooks.install?.({
                  installRoot: stageRoot,
                  requestedVersion: requestedVersion ?? "latest",
                  resolvedVersion,
                  stageRoot,
                }) ?? Promise.reject(new Error("missing install hook")),
              catch: (cause) =>
                userError("installer.installRepoBootstrap", cause instanceof Error ? cause.message : String(cause)),
            })).entrypointCommand
          : []

      const installRootPath = yield* finalizeInstall(stageRoot, implementationId, resolvedVersion)
      const hostPlatform = yield* requireHostPlatform()

      return createInstallRecord(implementationId, supportTier, {
        backend: "local",
        entrypointCommand: rewriteInstallRootPaths(entrypointCommand, stageRoot, installRootPath),
        installRoot: installRootPath,
        installStrategy: strategy.strategy,
        platform: hostPlatform,
        requestedVersion: requestedVersion ?? "latest",
        resolvedVersion,
        sourceReference: strategy.repository,
        verificationSummary: "git-clone",
      })
    })

    const installWithStrategy = Effect.fn("ClawctlInstallerService.installWithStrategy")(function* (
      implementationId: string,
      supportTier: InstallRecord["supportTier"],
      strategy: InstallManifest,
      requestedVersion?: string,
    ) {
      switch (strategy.strategy) {
        case "github-release":
          return yield* installGithubRelease(implementationId, supportTier, strategy, requestedVersion)
        case "npm-package":
          return yield* installNpmPackage(implementationId, supportTier, strategy, requestedVersion)
        case "python-package":
          return yield* installPythonPackage(implementationId, supportTier, strategy, requestedVersion)
        case "repo-bootstrap":
          return yield* installRepoBootstrap(implementationId, supportTier, strategy, requestedVersion)
        default:
          return yield* userError(
            "installer.installWithStrategy",
            `local install strategy is not implemented for ${implementationId}: ${strategy.strategy}`,
          )
      }
    })

    const installImplementation = Effect.fn("ClawctlInstallerService.installImplementation")(function* (
      implementation: string,
      version?: string,
    ) {
      const registration = yield* resolveRegistration(implementation)
      const backend = registration.manifest.backends.find((entry) => entry.kind === "local" && entry.supported)
      if (!backend) {
        return yield* userError("installer.installImplementation", `local backend is not supported: ${implementation}`)
      }

      const [strategy] = backend.install
      if (!strategy) {
        return yield* userError(
          "installer.installImplementation",
          `local install strategy is not configured for ${implementation}`,
        )
      }

      yield* withSystemError("installer.ensureRootDir", fs.makeDirectory(paths.rootDir, { recursive: true }))
      yield* withSystemError("installer.ensureConfigDir", fs.makeDirectory(paths.configDir, { recursive: true }))
      yield* withSystemError("installer.ensureCacheDir", fs.makeDirectory(paths.cacheDir, { recursive: true }))
      yield* withSystemError("installer.ensureInstallDir", fs.makeDirectory(paths.installDir, { recursive: true }))
      yield* withSystemError("installer.ensureRuntimeDir", fs.makeDirectory(paths.runtimeDir, { recursive: true }))
      yield* withSystemError("installer.ensureLogDir", fs.makeDirectory(paths.logDir, { recursive: true }))
      yield* withSystemError(
        "installer.ensureInstallParent",
        fs.makeDirectory(installParentDir(implementation), { recursive: true }),
      )
      yield* store.cleanupPartialInstallDirectories(implementation)

      const record = yield* installWithStrategy(
        implementation,
        registration.manifest.supportTier,
        strategy,
        version,
      ).pipe(
        Effect.catchAll((error) =>
          store.cleanupPartialInstallDirectories(implementation).pipe(Effect.zipRight(Effect.fail(error))),
        ),
      )

      yield* store.writeInstallRecord(record)
      yield* store.cleanupPartialInstallDirectories(implementation)
      return record
    })

    const listRemoteVersions = Effect.fn("ClawctlInstallerService.listRemoteVersions")(function* (
      implementation: string,
    ) {
      const registration = yield* resolveRegistration(implementation)
      const backend = registration.manifest.backends.find((entry) => entry.supported && entry.install.length > 0)
      if (!backend) {
        return yield* userError(
          "installer.listRemoteVersions",
          `no supported install backend is configured for ${implementation}`,
        )
      }

      const [strategy] = backend.install
      if (!strategy) {
        return yield* userError(
          "installer.listRemoteVersions",
          `install strategy is not configured for ${implementation}`,
        )
      }

      const versions = yield* listVersionsFromSource(implementation, strategy.versionSource)
      if (versions.length === 0) {
        return yield* userError("installer.listRemoteVersions", `no remote versions found for ${implementation}`)
      }
      return versions
    })

    return ClawctlInstallerService.of({
      installImplementation,
      listRemoteVersions,
    })
  }),
)
