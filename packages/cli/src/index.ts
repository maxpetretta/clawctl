#!/usr/bin/env bun
import { Args, CliConfig, Command, HelpDoc, Options, Span } from "@effect/cli"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as Terminal from "@effect/platform/Terminal"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { resolveRuntime, runtimeBackends } from "./model.ts"
import { ClawctlLive, ClawctlService } from "./service.ts"

const runtimeOption = Options.choice("runtime", runtimeBackends).pipe(
  Options.optional,
  Options.withDescription("Runtime backend to use. Only `local` is implemented today."),
  Options.withPseudoName("local|docker"),
)
const installedOnlyOption = Options.boolean("installed").pipe(
  Options.withDescription("Show only installed versions instead of the full registry."),
)
const allOption = Options.boolean("all").pipe(
  Options.withDescription("Remove every installed version of the selected implementation."),
)

const requiredTarget = Args.text({ name: "target" }).pipe(
  Args.withDescription("Implementation id, optionally pinned as <implementation>@<version>."),
)
const optionalTarget = Args.text({ name: "target" }).pipe(
  Args.optional,
  Args.withDescription("Optional implementation target. Defaults to the active claw when omitted."),
)
const requiredKey = Args.text({ name: "key" }).pipe(Args.withDescription("Shared config key to read or update."))
const requiredValue = Args.text({ name: "value" }).pipe(Args.withDescription("New value to store in shared config."))
const requiredMessage = Args.text({ name: "message" }).pipe(
  Args.withDescription("User message to send to the selected claw."),
)

const rootCommand = Command.make("clawctl", {}, () =>
  Effect.flatMap(Terminal.Terminal, (terminal) => terminal.display("Use a subcommand. Try clawctl --help.\n")),
).pipe(Command.withDescription("Install, switch, and run supported claw implementations."))

const installCommand = Command.make(
  "install",
  { runtime: runtimeOption, target: requiredTarget },
  ({ runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.install({ runtime: resolveRuntime(runtime), target })),
).pipe(Command.withDescription("Download and install a claw into the local clawctl store."))

const uninstallCommand = Command.make(
  "uninstall",
  { all: allOption, runtime: runtimeOption, target: requiredTarget },
  ({ all, runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.uninstall({ all, runtime: resolveRuntime(runtime), target })),
).pipe(Command.withDescription("Remove one installed version, or all installed versions, of a claw."))

const useCommand = Command.make("use", { runtime: runtimeOption, target: requiredTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.use({ runtime: resolveRuntime(runtime), target })),
).pipe(Command.withDescription("Set the active claw, installing it first if needed."))

const currentCommand = Command.make("current", {}, () =>
  Effect.flatMap(ClawctlService, (service) => service.current),
).pipe(Command.withDescription("Show the currently active claw selection."))

const cleanupCommand = Command.make("cleanup", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.cleanup({ target })),
).pipe(Command.withDescription("Remove stale partial installs, orphaned runtimes, and invalid current selections."))

const listCommand = Command.make("list", { installedOnly: installedOnlyOption }, ({ installedOnly }) =>
  Effect.flatMap(ClawctlService, (service) => service.list({ installedOnly })),
).pipe(Command.withDescription("List supported claws or only the versions installed locally."))

const versionsCommand = Command.make("versions", { target: requiredTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.versions(target)),
).pipe(Command.withDescription("List installable remote versions for a claw."))

const doctorCommand = Command.make("doctor", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.doctor({ target })),
).pipe(Command.withDescription("Run adapter, toolchain, config, and install checks."))

const statusCommand = Command.make("status", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.status({ target })),
).pipe(Command.withDescription("Show install and runtime metadata for a claw."))

const pingCommand = Command.make("ping", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.ping({ target })),
).pipe(Command.withDescription("Send the built-in ping prompt to a claw and print the response."))

const chatCommand = Command.make("chat", { message: requiredMessage, target: optionalTarget }, ({ message, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.chat({ message, target })),
).pipe(Command.withDescription("Send a one-shot message to a claw and print the reply."))

const stopCommand = Command.make("stop", { runtime: runtimeOption, target: optionalTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.stop({ runtime: resolveRuntime(runtime), target })),
).pipe(Command.withDescription("Stop a claw runtime when the selected backend supports resident processes."))

const configCommand = Command.make("config", {}, () =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display("Use `clawctl config get` or `clawctl config set`.\n"),
  ),
).pipe(Command.withDescription("Read or update shared clawctl configuration."))

const configGetCommand = Command.make("get", { key: requiredKey }, ({ key }) =>
  Effect.flatMap(ClawctlService, (service) => service.configGet(key)),
).pipe(Command.withDescription("Print the current value of a shared config key."))

const configSetCommand = Command.make("set", { key: requiredKey, value: requiredValue }, ({ key, value }) =>
  Effect.flatMap(ClawctlService, (service) => service.configSet({ key, value })),
).pipe(Command.withDescription("Persist a shared config value used during runtime config rendering."))

const configTree = configCommand.pipe(Command.withSubcommands([configGetCommand, configSetCommand]))

const command = rootCommand.pipe(
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    useCommand,
    currentCommand,
    cleanupCommand,
    listCommand,
    versionsCommand,
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
  summary: Span.text("Install, switch, and run supported claw implementations."),
  footer: HelpDoc.blocks([
    HelpDoc.h2("Examples"),
    HelpDoc.p("clawctl install openclaw"),
    HelpDoc.p("clawctl use openclaw@2026.3.7"),
    HelpDoc.p('clawctl chat "hello"'),
    HelpDoc.p("clawctl doctor"),
  ]),
})

const MainLayer = ClawctlLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      BunContext.layer,
      FetchHttpClient.layer,
      CliConfig.layer({
        showBuiltIns: false,
        showTypes: false,
      }),
    ),
  ),
)

cli(process.argv).pipe(Effect.provide(MainLayer), BunRuntime.runMain)
