import { Context, type Effect, Layer, type Option } from "effect"

import type { RuntimeBackend } from "./model.ts"
import { operations } from "./operations.ts"

type TargetSelection = {
  runtime: RuntimeBackend
  target: string
}

type MaybeTargetSelection = {
  runtime: RuntimeBackend
  target: Option.Option<string>
}

export type ClawctlApi = {
  chat: (input: { message: string; target: Option.Option<string> }) => Effect.Effect<void, unknown>
  cleanup: (input: { target: Option.Option<string> }) => Effect.Effect<void, unknown>
  configGet: (key: string) => Effect.Effect<void, unknown>
  configSet: (input: { key: string; value: string }) => Effect.Effect<void, unknown>
  current: Effect.Effect<void, unknown>
  doctor: (input: { target: Option.Option<string> }) => Effect.Effect<void, unknown>
  install: (input: TargetSelection) => Effect.Effect<void, unknown>
  list: (input: { installedOnly: boolean }) => Effect.Effect<void, unknown>
  ping: (input: { target: Option.Option<string> }) => Effect.Effect<void, unknown>
  status: (input: { target: Option.Option<string> }) => Effect.Effect<void, unknown>
  stop: (input: MaybeTargetSelection) => Effect.Effect<void, unknown>
  uninstall: (input: TargetSelection & { all: boolean }) => Effect.Effect<void, unknown>
  use: (input: TargetSelection) => Effect.Effect<void, unknown>
}

export class ClawctlService extends Context.Tag("ClawctlService")<ClawctlService, ClawctlApi>() {}

export const ClawctlLive = Layer.succeed(ClawctlService, {
  chat: operations.chat,
  cleanup: operations.cleanup,
  configGet: operations.configGet,
  configSet: operations.configSet,
  current: operations.current,
  doctor: operations.doctor,
  install: operations.install,
  list: operations.list,
  ping: operations.ping,
  status: operations.status,
  stop: operations.stop,
  uninstall: operations.uninstall,
  use: operations.use,
} satisfies ClawctlApi)
