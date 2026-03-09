import { Option } from "effect"

export const runtimeBackends = ["local", "docker"] as const

export type RuntimeBackend = (typeof runtimeBackends)[number]

export function resolveRuntime(runtime: Option.Option<RuntimeBackend>): RuntimeBackend {
  return Option.match(runtime, {
    onNone: () => "local",
    onSome: (value) => value,
  })
}
