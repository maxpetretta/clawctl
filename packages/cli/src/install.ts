import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, resolve } from "node:path"
import { promisify } from "node:util"

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
import type { ClawctlPaths } from "./paths.ts"
import { ensureBaseLayout, installParentDir, installRoot, partialInstallRoot } from "./paths.ts"
import { requireV1HostPlatform } from "./platform.ts"
import { cleanupPartialInstallDirectories, installBinary, writeInstallRecord } from "./state.ts"
import { gitExecutable, npmExecutable, uvExecutable } from "./tooling.ts"

const execFileAsync = promisify(execFile)

type GithubReleaseResponse = {
  tag_name: string
  assets: Array<{
    name: string
    browser_download_url: string
  }>
}

type PypiPackageResponse = {
  info: {
    version: string
  }
}

function githubApiOrigin(): string {
  return process.env.CLAWCTL_GITHUB_API_ORIGIN?.replace(/\/+$/u, "") ?? "https://api.github.com"
}

function pypiApiOrigin(): string {
  return process.env.CLAWCTL_PYPI_API_ORIGIN?.replace(/\/+$/u, "") ?? "https://pypi.org"
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "clawctl" },
  })
  if (!response.ok) {
    throw new Error(`request failed: ${response.status} ${response.statusText}`)
  }
  return (await response.json()) as T
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": "clawctl" },
  })
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  await writeFile(destination, new Uint8Array(arrayBuffer))
}

function selectAsset(manifest: GithubReleaseInstallManifest, assets: GithubReleaseResponse["assets"]) {
  const host = requireV1HostPlatform()
  const rule = manifest.assetRules.find(
    (candidate) => candidate.match.os === host.os && candidate.match.arch === host.arch,
  )
  if (!rule) {
    throw new Error(`no asset rule for ${manifest.repository} on ${host.os}-${host.arch}`)
  }

  const asset = assets.find((candidate) => candidate.name === rule.pattern)
  if (!asset) {
    throw new Error(`release asset not found for ${manifest.repository}: ${rule.pattern}`)
  }

  return { asset, rule, host }
}

async function verifyChecksum(
  manifest: GithubReleaseInstallManifest,
  assets: GithubReleaseResponse["assets"],
  assetName: string,
  assetPath: string,
): Promise<string | undefined> {
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

  const checksumPath = resolve(tmpdir(), `${basename(assetPath)}.checksums`)
  await downloadFile(checksumAsset.browser_download_url, checksumPath)
  const source = await readFile(checksumPath, "utf8")
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

  const actual = createHash("sha256")
    .update(new Uint8Array(await readFile(assetPath)))
    .digest("hex")
  if (actual !== expected) {
    throw new Error(`checksum verification failed for ${assetName}`)
  }

  return `sha256:${actual}`
}

async function materializeReleaseBinary(
  assetPath: string,
  archiveKind: GithubReleaseInstallManifest["assetRules"][number]["archive"],
  destinationRoot: string,
  binaryName: string,
): Promise<string> {
  const binDir = resolve(destinationRoot, "bin")
  await mkdir(binDir, { recursive: true })
  const destination = resolve(binDir, binaryName)

  if (archiveKind.kind === "none") {
    await rename(assetPath, destination)
    await installBinary(destination)
    return destination
  }

  const extractDir = resolve(destinationRoot, ".extract")
  await mkdir(extractDir, { recursive: true })

  if (archiveKind.kind === "tar.gz") {
    await execFileAsync("tar", ["-xzf", assetPath, "-C", extractDir])
  } else {
    await execFileAsync("unzip", ["-o", assetPath, "-d", extractDir])
  }

  const extractedBinary = resolve(extractDir, archiveKind.binaryPath)
  await rename(extractedBinary, destination)
  await installBinary(destination)
  return destination
}

async function resolveNpmVersion(strategy: NpmPackageInstallManifest, requestedVersion?: string): Promise<string> {
  if (requestedVersion) {
    return requestedVersion
  }

  const { stdout } = await execFileAsync(npmExecutable(), ["view", strategy.packageName, "version", "--json"], {
    env: process.env,
  })
  const source = stdout.trim()
  if (source.length === 0) {
    throw new Error(`failed to resolve npm version for ${strategy.packageName}`)
  }
  const parsed = JSON.parse(source) as string
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new Error(`invalid npm version response for ${strategy.packageName}`)
  }
  return parsed
}

async function resolvePythonVersion(
  strategy: PythonPackageInstallManifest,
  requestedVersion?: string,
): Promise<string> {
  if (requestedVersion) {
    return requestedVersion
  }

  const response = await fetchJson<PypiPackageResponse>(`${pypiApiOrigin()}/pypi/${strategy.packageName}/json`)
  const version = response.info.version.trim()
  if (version.length === 0) {
    throw new Error(`failed to resolve PyPI version for ${strategy.packageName}`)
  }
  return version
}

function resolveStaticVersion(versionSource: VersionSourceManifest): string {
  if (versionSource.kind !== "static") {
    throw new Error("static version source is required")
  }

  const [first] = versionSource.versions
  if (!first) {
    throw new Error("static version source has no versions")
  }
  return first
}

function stageToken(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function finalizeInstall(
  paths: ClawctlPaths,
  stageRoot: string,
  implementationId: string,
  version: string,
): Promise<string> {
  const destinationRoot = installRoot(paths, implementationId, version)
  await rm(destinationRoot, { recursive: true, force: true })
  await rename(stageRoot, destinationRoot)
  return destinationRoot
}

async function installGithubRelease(
  paths: ClawctlPaths,
  implementationId: string,
  strategy: GithubReleaseInstallManifest,
  requestedVersion?: string,
): Promise<InstallRecord> {
  const releaseUrl = requestedVersion
    ? `${githubApiOrigin()}/repos/${strategy.repository}/releases/tags/${requestedVersion}`
    : `${githubApiOrigin()}/repos/${strategy.repository}/releases/latest`
  const release = await fetchJson<GithubReleaseResponse>(releaseUrl)
  const { asset, rule, host } = selectAsset(strategy, release.assets)
  const resolvedVersion = release.tag_name
  const stageRoot = partialInstallRoot(paths, implementationId, resolvedVersion, stageToken())
  const cacheDir = resolve(paths.cacheDir, "downloads", implementationId, resolvedVersion)
  await mkdir(cacheDir, { recursive: true })
  await mkdir(stageRoot, { recursive: true })

  const assetPath = resolve(cacheDir, asset.name)
  await downloadFile(asset.browser_download_url, assetPath)
  const verificationSummary = await verifyChecksum(strategy, release.assets, asset.name, assetPath)
  await materializeReleaseBinary(assetPath, rule.archive, stageRoot, implementationId)
  const installRootPath = await finalizeInstall(paths, stageRoot, implementationId, resolvedVersion)

  return createInstallRecord(implementationId, {
    backend: "local",
    entrypointCommand: [resolve(installRootPath, "bin", implementationId)],
    installRoot: installRootPath,
    installStrategy: strategy.strategy,
    platform: host,
    requestedVersion: requestedVersion ?? "latest",
    resolvedVersion,
    sourceReference: strategy.repository,
    verificationSummary,
  })
}

function createInstallRecord(
  implementationId: string,
  input: Omit<InstallRecord, "implementation" | "installedAt" | "supportTier">,
): InstallRecord {
  return {
    implementation: implementationId,
    ...input,
    installedAt: new Date().toISOString(),
    supportTier: getRegisteredImplementation(implementationId).manifest.supportTier,
  }
}

async function installNpmPackage(
  paths: ClawctlPaths,
  implementationId: string,
  strategy: NpmPackageInstallManifest,
  requestedVersion?: string,
): Promise<InstallRecord> {
  const resolvedVersion = await resolveNpmVersion(strategy, requestedVersion)
  const stageRoot = partialInstallRoot(paths, implementationId, resolvedVersion, stageToken())
  await mkdir(stageRoot, { recursive: true })
  await writeFile(
    resolve(stageRoot, "package.json"),
    JSON.stringify({ name: `clawctl-${implementationId}`, private: true }, null, 2),
  )

  await execFileAsync(
    npmExecutable(),
    ["install", "--prefix", stageRoot, "--no-save", `${strategy.packageName}@${resolvedVersion}`],
    { env: process.env },
  )

  const binaryPath = resolve(stageRoot, "node_modules", ".bin", strategy.binName)
  await access(binaryPath)
  const installRootPath = await finalizeInstall(paths, stageRoot, implementationId, resolvedVersion)

  return createInstallRecord(implementationId, {
    backend: "local",
    entrypointCommand: [resolve(installRootPath, "node_modules", ".bin", strategy.binName)],
    installRoot: installRootPath,
    installStrategy: strategy.strategy,
    platform: requireV1HostPlatform(),
    requestedVersion: requestedVersion ?? "latest",
    resolvedVersion,
    sourceReference: strategy.packageName,
    verificationSummary: "registry-managed",
  })
}

async function installPythonPackage(
  paths: ClawctlPaths,
  implementationId: string,
  strategy: PythonPackageInstallManifest,
  requestedVersion?: string,
): Promise<InstallRecord> {
  if (strategy.installer !== "uv-tool") {
    throw new Error(`python installer is not implemented yet: ${strategy.installer}`)
  }

  const resolvedVersion = await resolvePythonVersion(strategy, requestedVersion)
  const stageRoot = partialInstallRoot(paths, implementationId, resolvedVersion, stageToken())
  await mkdir(stageRoot, { recursive: true })

  await execFileAsync(
    uvExecutable(),
    ["tool", "install", "--tool-dir", stageRoot, `${strategy.packageName}==${resolvedVersion}`],
    { env: process.env },
  )

  const binaryPath = resolve(stageRoot, "bin", strategy.entrypoint)
  await access(binaryPath)
  const installRootPath = await finalizeInstall(paths, stageRoot, implementationId, resolvedVersion)

  return createInstallRecord(implementationId, {
    backend: "local",
    entrypointCommand: [resolve(installRootPath, "bin", strategy.entrypoint)],
    installRoot: installRootPath,
    installStrategy: strategy.strategy,
    platform: requireV1HostPlatform(),
    requestedVersion: requestedVersion ?? "latest",
    resolvedVersion,
    sourceReference: strategy.packageName,
    verificationSummary: "registry-managed",
  })
}

async function installRepoBootstrap(
  paths: ClawctlPaths,
  implementationId: string,
  strategy: RepoBootstrapInstallManifest,
  requestedVersion?: string,
): Promise<InstallRecord> {
  const resolvedVersion = requestedVersion ?? resolveStaticVersion(strategy.versionSource)
  const stageRoot = partialInstallRoot(paths, implementationId, resolvedVersion, stageToken())
  const repoDir = resolve(stageRoot, "repo")
  await mkdir(stageRoot, { recursive: true })

  if (strategy.refPolicy === "commit") {
    await execFileAsync(gitExecutable(), ["clone", strategy.repository, repoDir], {
      env: process.env,
    })
    await execFileAsync(gitExecutable(), ["-C", repoDir, "checkout", resolvedVersion], {
      env: process.env,
    })
  } else {
    await execFileAsync(
      gitExecutable(),
      ["clone", "--depth", "1", "--branch", resolvedVersion, strategy.repository, repoDir],
      {
        env: process.env,
      },
    )
  }

  const installRootPath = await finalizeInstall(paths, stageRoot, implementationId, resolvedVersion)

  return createInstallRecord(implementationId, {
    backend: "local",
    entrypointCommand: [],
    installRoot: installRootPath,
    installStrategy: strategy.strategy,
    platform: requireV1HostPlatform(),
    requestedVersion: requestedVersion ?? "latest",
    resolvedVersion,
    sourceReference: strategy.repository,
    verificationSummary: "git-clone",
  })
}

function installWithStrategy(
  paths: ClawctlPaths,
  implementationId: string,
  strategy: InstallManifest,
  requestedVersion?: string,
): Promise<InstallRecord> {
  switch (strategy.strategy) {
    case "github-release":
      return installGithubRelease(paths, implementationId, strategy, requestedVersion)
    case "npm-package":
      return installNpmPackage(paths, implementationId, strategy, requestedVersion)
    case "python-package":
      return installPythonPackage(paths, implementationId, strategy, requestedVersion)
    case "repo-bootstrap":
      return installRepoBootstrap(paths, implementationId, strategy, requestedVersion)
    default:
      throw new Error(`local install strategy is not implemented for ${implementationId}: ${strategy.strategy}`)
  }
}

export async function installImplementation(
  paths: ClawctlPaths,
  implementationId: string,
  requestedVersion?: string,
): Promise<InstallRecord> {
  const registration = getRegisteredImplementation(implementationId)
  const backend = registration.manifest.backends.find((entry) => entry.kind === "local" && entry.supported)
  if (!backend) {
    throw new Error(`local backend is not supported: ${implementationId}`)
  }

  const [strategy] = backend.install
  if (!strategy) {
    throw new Error(`local install strategy is not configured for ${implementationId}`)
  }

  await ensureBaseLayout(paths)
  await mkdir(installParentDir(paths, implementationId), { recursive: true })
  await cleanupPartialInstallDirectories(paths, implementationId)

  let record: InstallRecord | undefined
  try {
    record = await installWithStrategy(paths, implementationId, strategy, requestedVersion)
  } catch (error) {
    await cleanupPartialInstallDirectories(paths, implementationId)
    throw error
  }

  await writeInstallRecord(paths, record)
  await cleanupPartialInstallDirectories(paths, implementationId)
  return record
}
