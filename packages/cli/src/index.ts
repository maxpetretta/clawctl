#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"

import { resolveRuntime, runtimeBackends } from "./model.ts"
import { ClawctlLive, ClawctlService } from "./service.ts"

const runtimeOption = Options.choice("runtime", runtimeBackends).pipe(Options.optional)
const installedOnlyOption = Options.boolean("installed")
const allOption = Options.boolean("all")

const requiredTarget = Args.text({ name: "target" })
const optionalTarget = Args.text({ name: "target" }).pipe(Args.optional)
const requiredKey = Args.text({ name: "key" })
const requiredValue = Args.text({ name: "value" })
const requiredMessage = Args.text({ name: "message" })

const rootCommand = Command.make("clawctl", {}, () => Console.log("Use a subcommand. Try clawctl --help."))

const installCommand = Command.make(
  "install",
  { runtime: runtimeOption, target: requiredTarget },
  ({ runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.install({ runtime: resolveRuntime(runtime), target })),
)

const uninstallCommand = Command.make(
  "uninstall",
  { all: allOption, runtime: runtimeOption, target: requiredTarget },
  ({ all, runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.uninstall({ all, runtime: resolveRuntime(runtime), target })),
)

const useCommand = Command.make("use", { runtime: runtimeOption, target: requiredTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.use({ runtime: resolveRuntime(runtime), target })),
)

const currentCommand = Command.make("current", {}, () => Effect.flatMap(ClawctlService, (service) => service.current))

const cleanupCommand = Command.make("cleanup", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.cleanup({ target })),
)

const listCommand = Command.make("list", { installedOnly: installedOnlyOption }, ({ installedOnly }) =>
  Effect.flatMap(ClawctlService, (service) => service.list({ installedOnly })),
)

const doctorCommand = Command.make("doctor", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.doctor({ target })),
)

const statusCommand = Command.make("status", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.status({ target })),
)

const pingCommand = Command.make("ping", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.ping({ target })),
)

const chatCommand = Command.make("chat", { message: requiredMessage, target: optionalTarget }, ({ message, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.chat({ message, target })),
)

const stopCommand = Command.make("stop", { runtime: runtimeOption, target: optionalTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.stop({ runtime: resolveRuntime(runtime), target })),
)

const configCommand = Command.make("config", {}, () => Console.log("Use `clawctl config get` or `clawctl config set`."))

const configGetCommand = Command.make("get", { key: requiredKey }, ({ key }) =>
  Effect.flatMap(ClawctlService, (service) => service.configGet(key)),
)

const configSetCommand = Command.make("set", { key: requiredKey, value: requiredValue }, ({ key, value }) =>
  Effect.flatMap(ClawctlService, (service) => service.configSet({ key, value })),
)

const configTree = configCommand.pipe(Command.withSubcommands([configGetCommand, configSetCommand]))

const command = rootCommand.pipe(
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    useCommand,
    currentCommand,
    cleanupCommand,
    listCommand,
    doctorCommand,
    statusCommand,
    pingCommand,
    chatCommand,
    stopCommand,
    configTree,
  ]),
)

const cli = Command.run(command, {
  name: "clawctl",
  version: "v2026.3.8",
})

cli(process.argv).pipe(Effect.provide(ClawctlLive), Effect.provide(NodeContext.layer), NodeRuntime.runMain)
