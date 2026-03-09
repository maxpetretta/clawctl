import { Effect } from "effect"

import {
  getRegisteredImplementation,
  installOnlyInteractionMessage,
  isInstallOnlyRegistration,
} from "./adapter/registry.ts"
import type { RegisteredImplementation } from "./adapter/types.ts"
import { type ClawctlUserError, userError } from "./errors.ts"
import { parseTargetReference } from "./target.ts"

export function makeResolveRegistration(module: string) {
  return Effect.fn(`${module}.resolveRegistration`)(function* (implementation: string) {
    return yield* Effect.try({
      try: () => getRegisteredImplementation(implementation),
      catch: (cause) =>
        userError(`${module}.resolveRegistration`, cause instanceof Error ? cause.message : String(cause)),
    })
  })
}

export function makeParseReference(module: string) {
  return Effect.fn(`${module}.parseReference`)(function* (target: string) {
    return yield* Effect.try({
      try: () => parseTargetReference(target),
      catch: (cause) =>
        userError(`${module}.parseTargetReference`, cause instanceof Error ? cause.message : String(cause)),
    })
  })
}

export function makeRequireInteractableImplementation(
  module: string,
  resolveRegistration: (implementation: string) => Effect.Effect<RegisteredImplementation, ClawctlUserError>,
) {
  return Effect.fn(`${module}.requireInteractableImplementation`)(function* (implementation: string, action: string) {
    const registration = yield* resolveRegistration(implementation)
    if (isInstallOnlyRegistration(registration)) {
      return yield* userError(`${module}.${action}`, installOnlyInteractionMessage(implementation))
    }
    return registration
  })
}
