#!/usr/bin/env bun
import { Args, CliConfig, Command, HelpDoc, Options, Span } from "@effect/cli"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import * as Terminal from "@effect/platform/Terminal"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

import { resolveRuntime, runtimeBackends } from "./model.ts"
import { maybeRunManagedDaemon, maybeRunShimmedCommand } from "./runtime-service.ts"
import { ClawctlLive, ClawctlService } from "./service.ts"

const version = "v2026.3.8"
const commandDescriptions = {
  chat: "Send a message to a managed claw runtime and print the reply.",
  cleanup: "Remove stale partial installs, orphaned runtimes, and invalid current selections.",
  config: "Read or update shared clawctl configuration.",
  configGet: "Print the current value of a shared config key.",
  configSet: "Persist a shared config value used during runtime config rendering.",
  current: "Show the currently active claw selection.",
  doctor: "Run adapter, toolchain, config, and install checks.",
  init: "Append clawctl PATH setup to your shell config for bash, zsh, or fish.",
  install: "Download and install a claw into the local clawctl store.",
  list: "List supported claws or only the versions installed locally.",
  ping: "Send the built-in ping prompt to a claw and print the response.",
  root: "Install, switch, and run supported claw implementations.",
  status: "Show install and runtime metadata for a claw.",
  stop: "Stop a claw runtime when the selected backend supports resident processes.",
  uninstall: "Remove one installed version, or all installed versions, of a claw.",
  use: "Set the active claw, installing it first if needed.",
  versions: "List installable remote versions for a claw.",
} as const
const rootHelpCommandOrder = [
  "install",
  "uninstall",
  "use",
  "current",
  "cleanup",
  "init",
  "list",
  "versions",
  "doctor",
  "status",
  "ping",
  "chat",
  "stop",
  "config",
] as const

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
  ({ runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.install({ runtime: resolveRuntime(runtime), target })),
).pipe(Command.withDescription(commandDescriptions.install))

const uninstallCommand = Command.make(
  "uninstall",
  { all: allOption, runtime: runtimeOption, target: requiredTarget },
  ({ all, runtime, target }) =>
    Effect.flatMap(ClawctlService, (service) => service.uninstall({ all, runtime: resolveRuntime(runtime), target })),
).pipe(Command.withDescription(commandDescriptions.uninstall))

const useCommand = Command.make("use", { runtime: runtimeOption, target: requiredTarget }, ({ runtime, target }) =>
  Effect.flatMap(ClawctlService, (service) => service.use({ runtime: resolveRuntime(runtime), target })),
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
  Effect.flatMap(ClawctlService, (service) => service.stop({ runtime: resolveRuntime(runtime), target })),
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
  summary: Span.text(commandDescriptions.root),
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

const rootHelpCommands = rootHelpCommandOrder.map((name) => [name, commandDescriptions[name]] as const)

function formatHelpRows(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const nameWidth = rows.reduce((width, [name]) => Math.max(width, name.length), 0)
  return rows.map(([name, description]) => `  ${name.padEnd(nameWidth)}  ${description}`)
}

function renderRootHelp(): string {
  return [
    `clawctl ${version}`,
    commandDescriptions.root,
    "",
    "Usage:",
    "  clawctl <command> [options]",
    "",
    "Commands:",
    ...formatHelpRows(rootHelpCommands),
    "",
    "Examples:",
    "  clawctl install openclaw",
    "  clawctl use openclaw@2026.3.7",
    '  clawctl chat "hello"',
    "  clawctl doctor",
    "",
    "Run 'clawctl <command> --help' for more information on a command.",
  ].join("\n")
}

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
  if (userArgs.length === 0 || (userArgs.length === 1 && (userArgs[0] === "--help" || userArgs[0] === "-h"))) {
    process.stdout.write(renderRootHelp())
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
