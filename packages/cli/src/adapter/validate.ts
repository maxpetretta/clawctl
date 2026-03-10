import { listRegisteredImplementations } from "./registry.ts"
import { backendKinds } from "./schema.ts"
import type { RegisteredImplementation } from "./types.ts"

export function validateAdapterRegistration(registration: RegisteredImplementation, seenIds = new Set<string>()): void {
  const { manifest } = registration
  const implementationHooks = (
    registration as {
      implementationHooks?: {
        start?: unknown
        status?: unknown
      }
    }
  ).implementationHooks

  if (seenIds.has(manifest.id)) {
    throw new Error(`duplicate adapter id: ${manifest.id}`)
  }
  seenIds.add(manifest.id)

  if (manifest.backends.length === 0) {
    throw new Error(`adapter ${manifest.id} has no backends`)
  }

  for (const backend of manifest.backends) {
    if (!backendKinds.includes(backend.kind)) {
      throw new Error(`adapter ${manifest.id} has unsupported backend kind`)
    }

    if (backend.supported && backend.install.length === 0) {
      throw new Error(`adapter ${manifest.id} backend ${backend.kind} has no install strategies`)
    }

    if (
      backend.supported &&
      backend.runtime.supervision.kind === "unmanaged" &&
      (manifest.capabilities.chat || manifest.capabilities.ping)
    ) {
      throw new Error(`adapter ${manifest.id} cannot declare chat or ping with unmanaged supervision`)
    }

    if (backend.runtime.supervision.kind === "native-daemon") {
      if (!implementationHooks?.start) {
        throw new Error(`adapter ${manifest.id} native-daemon supervision requires a start hook`)
      }
      if (!implementationHooks?.status) {
        throw new Error(`adapter ${manifest.id} native-daemon supervision requires a status hook`)
      }
    }
  }
}

export function validateAdapterRegistry(): void {
  const seenIds = new Set<string>()
  for (const registration of listRegisteredImplementations()) {
    validateAdapterRegistration(registration, seenIds)
  }
}
