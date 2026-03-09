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

const PypiPackageResponseSchema = Schema.Struct({
  info: Schema.Struct({
    version: Schema.String,
  }),
})

const JsonStringSchema = Schema.parseJson(Schema.String)

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

    const resolveStaticVersion = Effect.fn("ClawctlInstallerService.resolveStaticVersion")(function* (
      versionSource: VersionSourceManifest,
    ) {
      if (versionSource.kind !== "static") {
        return yield* userError("installer.resolveStaticVersion", "static version source is required")
      }

      const [first] = versionSource.versions
      if (!first) {
        return yield* userError("installer.resolveStaticVersion", "static version source has no versions")
      }
      return first
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

      const extractedBinary = path.resolve(extractDir, archiveKind.binaryPath)
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
      yield* withSystemError("installer.makeStageDir", fs.makeDirectory(stageRoot, { recursive: true }))

      yield* runCommand(
        "installer.installPythonPackage",
        uvExecutable(),
        ["tool", "install", "--tool-dir", stageRoot, `${strategy.packageName}==${resolvedVersion}`],
        { env: process.env },
      )

      const binaryPath = path.resolve(stageRoot, "bin", strategy.entrypoint)
      yield* withSystemError("installer.checkPythonBinary", fs.access(binaryPath))
      const installRootPath = yield* finalizeInstall(stageRoot, implementationId, resolvedVersion)
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
      const resolvedVersion = requestedVersion ?? (yield* resolveStaticVersion(strategy.versionSource))
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

      const installRootPath = yield* finalizeInstall(stageRoot, implementationId, resolvedVersion)
      const hostPlatform = yield* requireHostPlatform()

      return createInstallRecord(implementationId, supportTier, {
        backend: "local",
        entrypointCommand: [],
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

    return ClawctlInstallerService.of({
      installImplementation,
    })
  }),
)
