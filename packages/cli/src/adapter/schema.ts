export const supportTiers = ["tier1", "tier2", "tier3"] as const

export type SupportTier = (typeof supportTiers)[number]

export const platformOperatingSystems = ["darwin", "linux", "windows"] as const

export type PlatformOperatingSystem = (typeof platformOperatingSystems)[number]

export const platformArchitectures = ["x64", "arm64", "armv7", "riscv64", "other"] as const

export type PlatformArchitecture = (typeof platformArchitectures)[number]

export const platformLibcs = ["gnu", "musl"] as const

export type PlatformLibc = (typeof platformLibcs)[number]

export type PlatformSelector = {
  os: PlatformOperatingSystem
  arch: PlatformArchitecture
  libc?: PlatformLibc
}

export const backendKinds = ["local", "docker"] as const

export type BackendKind = (typeof backendKinds)[number]

export const runtimeModes = ["oneshot", "daemon", "http", "telegram-bot", "external"] as const

export type RuntimeMode = (typeof runtimeModes)[number]

export const homeStrategies = ["isolated-home", "native-home", "custom-env"] as const

export type HomeStrategy = (typeof homeStrategies)[number]

export const workspaceStrategies = ["shared", "per-implementation", "per-runtime"] as const

export type WorkspaceStrategy = (typeof workspaceStrategies)[number]

export const configFileFormats = ["json", "toml", "yaml", "env", "text"] as const

export type ConfigFileFormat = (typeof configFileFormats)[number]

export const installStrategyKinds = [
  "github-release",
  "npm-package",
  "python-package",
  "repo-bootstrap",
  "docker-build",
  "source-build",
] as const

export type InstallStrategyKind = (typeof installStrategyKinds)[number]

export const versionSourceKinds = ["github-releases", "npm", "pypi", "git-tags", "static", "adapter-hook"] as const

export type VersionSourceKind = (typeof versionSourceKinds)[number]

export const hookPhases = [
  "resolveVersions",
  "install",
  "renderConfig",
  "start",
  "stop",
  "status",
  "ping",
  "chat",
  "doctor",
] as const

export type HookPhase = (typeof hookPhases)[number]

export type AdapterHookReference = {
  kind: "adapter-hook"
  hook: HookPhase
}

export type SharedConfigKey = string

export type VersionSourceManifest =
  | {
      kind: "github-releases"
      repository: string
    }
  | {
      kind: "npm"
      packageName: string
    }
  | {
      kind: "pypi"
      packageName: string
    }
  | {
      kind: "git-tags"
      repository: string
    }
  | {
      kind: "static"
      versions: string[]
    }
  | AdapterHookReference

export type InstallCommon = {
  strategy: InstallStrategyKind
  priority: number
  supportedPlatforms: PlatformSelector[]
  versionSource: VersionSourceManifest
}

export type GithubReleaseArchive =
  | { kind: "none" }
  | {
      kind: "tar.gz"
      binaryPath: string
    }
  | {
      kind: "zip"
      binaryPath: string
    }

export type GithubReleaseVerification =
  | { kind: "none" }
  | {
      kind: "checksum-file"
      assetPattern: string
    }
  | {
      kind: "sigstore"
      assetPattern: string
    }

export type GithubReleaseInstallManifest = InstallCommon & {
  strategy: "github-release"
  repository: string
  assetRules: Array<{
    match: PlatformSelector
    pattern: string
    archive: GithubReleaseArchive
  }>
  verification?: GithubReleaseVerification
}

export type NpmPackageInstallManifest = InstallCommon & {
  strategy: "npm-package"
  packageName: string
  binName: string
}

export const pythonPackageInstallers = ["uv-tool", "uv-venv", "pip-venv"] as const

export type PythonPackageInstaller = (typeof pythonPackageInstallers)[number]

export type PythonPackageInstallManifest = InstallCommon & {
  strategy: "python-package"
  packageName: string
  installer: PythonPackageInstaller
  entrypoint: string
}

export const repoBootstrapRefPolicies = ["tag", "branch", "commit"] as const

export type RepoBootstrapRefPolicy = (typeof repoBootstrapRefPolicies)[number]

export type RepoBootstrapInstallManifest = InstallCommon & {
  strategy: "repo-bootstrap"
  repository: string
  refPolicy: RepoBootstrapRefPolicy
  bootstrapHook: HookPhase
}

export type DockerBuildInstallManifest = InstallCommon & {
  strategy: "docker-build"
  context: string
  dockerfile?: string
  image?: string
}

export type SourceBuildInstallManifest = InstallCommon & {
  strategy: "source-build"
  repository: string
  buildHook: HookPhase
}

export type InstallManifest =
  | GithubReleaseInstallManifest
  | NpmPackageInstallManifest
  | PythonPackageInstallManifest
  | RepoBootstrapInstallManifest
  | DockerBuildInstallManifest
  | SourceBuildInstallManifest

export type RuntimeEntrypoint =
  | {
      kind: "exec"
      command: string[]
    }
  | AdapterHookReference

export type RuntimeHealthCheck =
  | {
      kind: "none"
    }
  | {
      kind: "process"
    }
  | {
      kind: "http"
      path?: string
      port?: number
    }
  | AdapterHookReference

export type RuntimeChatConfig =
  | {
      kind: "argv"
      command: string[]
    }
  | {
      kind: "http"
      path: string
      method: "POST"
    }
  | AdapterHookReference

export type RuntimePingConfig =
  | {
      kind: "prompt"
      text: string
    }
  | {
      kind: "http"
      path: string
      method: "GET" | "POST"
    }
  | AdapterHookReference

export type RuntimeManifest = {
  mode: RuntimeMode
  homeStrategy: HomeStrategy
  workspaceStrategy: WorkspaceStrategy
  entrypoint: RuntimeEntrypoint
  health: RuntimeHealthCheck
  chat: RuntimeChatConfig
  ping: RuntimePingConfig
}

export type ConfigFileTemplate =
  | {
      kind: "inline"
      value: string
    }
  | {
      kind: "file"
      path: string
    }
  | AdapterHookReference

export type ConfigFileManifest = {
  path: string
  format: ConfigFileFormat
  template: ConfigFileTemplate
  requiredKeys: string[]
}

export type ConfigEnvManifest = {
  name: string
  valueFrom:
    | {
        kind: "shared-key"
        key: SharedConfigKey
      }
    | {
        kind: "literal"
        value: string
      }
    | AdapterHookReference
}

export type ConfigManifest = {
  sharedKeys: SharedConfigKey[]
  files: ConfigFileManifest[]
  env: ConfigEnvManifest[]
}

export type CapabilityManifest = {
  chat: boolean
  ping: boolean
  status: boolean
  telegram: boolean
  local: boolean
  docker: boolean
  oneshot: boolean
  daemon: boolean
}

export type BackendManifest = {
  kind: BackendKind
  supported: boolean
  install: InstallManifest[]
  runtime: RuntimeManifest
}

export type ImplementationManifest = {
  id: string
  displayName: string
  supportTier: SupportTier
  description: string
  repository?: string
  docsUrl?: string
  backends: BackendManifest[]
  capabilities: CapabilityManifest
  config: ConfigManifest
}
