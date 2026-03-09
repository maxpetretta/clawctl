import type { BackendKind, ImplementationManifest, PlatformSelector, SupportTier } from "./schema.ts"

export type InstallRecord = {
  implementation: string
  requestedVersion: string
  resolvedVersion: string
  backend: BackendKind
  installStrategy: string
  installRoot: string
  entrypointCommand: string[]
  platform: PlatformSelector
  sourceReference: string
  verificationSummary?: string | undefined
  installedAt: string
  supportTier: SupportTier
}

export type RuntimeRecord = {
  implementation: string
  version: string
  backend: BackendKind
  runtimeRoot: string
  active: boolean
  managedByClawctl: boolean
  pid?: number
  port?: number
  proxyMode: "proxy" | "native-daemon"
  state: "starting" | "running" | "stopped" | "failed"
  startedAt?: string
  stoppedAt?: string
  updatedAt: string
  lastError?: string
}

export type CurrentSelection = {
  implementation: string
  version: string
  backend: BackendKind
}

export type RegisteredImplementation = {
  manifest: ImplementationManifest
}
