import { Option } from "effect"

export const runtimeBackends = ["local", "docker"] as const

export type RuntimeBackend = (typeof runtimeBackends)[number]

export function isRuntimeBackend(value: string): value is RuntimeBackend {
  return runtimeBackends.includes(value as RuntimeBackend)
}

export function parseRuntimeBackend(value: string | undefined): RuntimeBackend | undefined {
  if (!value) {
    return undefined
  }
  return isRuntimeBackend(value) ? value : undefined
}

export function resolveRuntime(runtime: Option.Option<RuntimeBackend>): RuntimeBackend {
  return Option.match(runtime, {
    onNone: () => "local",
    onSome: (value) => value,
  })
}
