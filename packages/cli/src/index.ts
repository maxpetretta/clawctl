#!/usr/bin/env bun
import { Args, CliConfig, Command, Options } from "@effect/cli"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as Terminal from "@effect/platform/Terminal"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { getHelpSummary, renderHelp, resolveHelpPath } from "./help.ts"
import { runtimeBackends } from "./model.ts"
import { maybeRunManagedDaemon, maybeRunShimmedCommand } from "./runtime-service.ts"
import { ClawctlLive, ClawctlService } from "./service.ts"

const version = "v2026.3.8"
const commandDescriptions = {
  chat: getHelpSummary(["chat"]),
  cleanup: getHelpSummary(["cleanup"]),
  config: getHelpSummary(["config"]),
  configGet: getHelpSummary(["config", "get"]),
  configSet: getHelpSummary(["config", "set"]),
  current: getHelpSummary(["current"]),
  doctor: getHelpSummary(["doctor"]),
  init: getHelpSummary(["init"]),
  install: getHelpSummary(["install"]),
  list: getHelpSummary(["list"]),
  ping: getHelpSummary(["ping"]),
  root: getHelpSummary([]),
  status: getHelpSummary(["status"]),
  stop: getHelpSummary(["stop"]),
  uninstall: getHelpSummary(["uninstall"]),
  use: getHelpSummary(["use"]),
  versions: getHelpSummary(["versions"]),
} as const

const runtimeOption = Options.choice("runtime", runtimeBackends).pipe(
  Options.optional,
  Options.withDescription("Runtime backend to use. Defaults to the configured CLAW_RUNTIME value."),
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
const optionalShell = Args.text({ name: "shell" }).pipe(
  Args.optional,
  Args.withDescription("Optional shell target. Defaults to the current SHELL when omitted."),
)

const rootCommand = Command.make("clawctl", {}, () => Effect.void).pipe(
  Command.withDescription(commandDescriptions.root),
)

const installCommand = Command.make(
  "install",
  { runtime: runtimeOption, target: requiredTarget },
  ({ runtime, target }) => Effect.flatMap(ClawctlService, (service) => service.install({ runtime, target })),
).pipe(Command.withDescription(commandDescriptions.install))

const uninstallCommand = Command.make(
  "uninstall",
  { all: allOption, runtime: runtimeOption, target: requiredTarget },
  ({ all, runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.uninstall({ all, runtime, target })),
).pipe(Command.withDescription(commandDescriptions.uninstall))

const useCommand = Command.make("use", { runtime: runtimeOption, target: requiredTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.use({ runtime, target })),
).pipe(Command.withDescription(commandDescriptions.use))

const currentCommand = Command.make("current", {}, () =>
  Effect.flatMap(ClawctlService, (service) => service.current),
).pipe(Command.withDescription(commandDescriptions.current))

const cleanupCommand = Command.make("cleanup", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.cleanup({ target })),
).pipe(Command.withDescription(commandDescriptions.cleanup))

const initCommand = Command.make("init", { shell: optionalShell }, ({ shell }) =>
  Effect.flatMap(ClawctlService, (service) => service.init({ shell })),
).pipe(Command.withDescription(commandDescriptions.init))

const listCommand = Command.make("list", { installedOnly: installedOnlyOption }, ({ installedOnly }) =>
  Effect.flatMap(ClawctlService, (service) => service.list({ installedOnly })),
).pipe(Command.withDescription(commandDescriptions.list))

const versionsCommand = Command.make("versions", { target: requiredTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.versions(target)),
).pipe(Command.withDescription(commandDescriptions.versions))

const doctorCommand = Command.make("doctor", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.doctor({ target })),
).pipe(Command.withDescription(commandDescriptions.doctor))

const statusCommand = Command.make("status", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.status({ target })),
).pipe(Command.withDescription(commandDescriptions.status))

const pingCommand = Command.make("ping", { target: optionalTarget }, ({ target }) =>
  Effect.flatMap(ClawctlService, (service) => service.ping({ target })),
).pipe(Command.withDescription(commandDescriptions.ping))

const chatCommand = Command.make("chat", { message: requiredMessage, target: optionalTarget }, ({ message, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.chat({ message, target })),
).pipe(Command.withDescription(commandDescriptions.chat))

const stopCommand = Command.make("stop", { runtime: runtimeOption, target: optionalTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.stop({ runtime, target })),
).pipe(Command.withDescription(commandDescriptions.stop))

const configCommand = Command.make("config", {}, () =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display("Use `clawctl config get` or `clawctl config set`.\n"),
  ),
).pipe(Command.withDescription(commandDescriptions.config))

const configGetCommand = Command.make("get", { key: requiredKey }, ({ key }) =>
  Effect.flatMap(ClawctlService, (service) => service.configGet(key)),
).pipe(Command.withDescription(commandDescriptions.configGet))

const configSetCommand = Command.make("set", { key: requiredKey, value: requiredValue }, ({ key, value }) =>
  Effect.flatMap(ClawctlService, (service) => service.configSet({ key, value })),
).pipe(Command.withDescription(commandDescriptions.configSet))

const configTree = configCommand.pipe(Command.withSubcommands([configGetCommand, configSetCommand]))

const command = rootCommand.pipe(
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    useCommand,
    currentCommand,
    cleanupCommand,
    initCommand,
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
  version,
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

const displayErrorAndExit = (message: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display(`${message}\n`).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1
        }),
      ),
    ),
  )

const handledDaemon = await maybeRunManagedDaemon(process.argv)
const handledShim = handledDaemon ? false : await maybeRunShimmedCommand(process.argv)
if (!(handledDaemon || handledShim)) {
  const userArgs = process.argv.slice(2)
  const helpPath = resolveHelpPath(userArgs)
  if (helpPath !== undefined) {
    process.stdout.write(renderHelp(helpPath, version))
    process.exit(0)
  }

  const argv = process.argv
  cli(argv).pipe(
    Effect.catchTags({
      ClawctlSystemError: (error) => displayErrorAndExit(error.message),
      ClawctlUserError: (error) => displayErrorAndExit(error.message),
    }),
    Effect.provide(MainLayer),
    BunRuntime.runMain,
  )
}
