type HelpPath = ReadonlyArray<string>

type HelpRow = {
  readonly description: string
  readonly name: string
}

type HelpGroup = {
  readonly entries: ReadonlyArray<HelpEntry>
  readonly title: string
}

type HelpEntry = {
  readonly args?: ReadonlyArray<HelpRow>
  readonly commandGroups?: ReadonlyArray<HelpGroup>
  readonly examples?: ReadonlyArray<string>
  readonly options?: ReadonlyArray<HelpRow>
  readonly summary: string
  readonly subcommands?: ReadonlyArray<HelpEntry>
  readonly usage: string
  readonly name: string
}

const helpOption: HelpRow = {
  name: "-h, --help",
  description: "Print usage.",
}

const versionOption: HelpRow = {
  name: "--version",
  description: "Print version information and exit.",
}

const runtimeOption: HelpRow = {
  name: "--runtime <local|docker>",
  description: "Choose a runtime backend. Defaults to the configured CLAW_RUNTIME value.",
}

const targetArgument: HelpRow = {
  name: "TARGET",
  description: "Claw implementation, optionally pinned as <implementation>@<version>.",
}

const optionalTargetArgument: HelpRow = {
  name: "TARGET",
  description: "Claw target. Uses the active claw when omitted.",
}

const keyArgument: HelpRow = {
  name: "KEY",
  description: "Shared configuration key to read or update.",
}

const valueArgument: HelpRow = {
  name: "VALUE",
  description: "New value to store for the shared configuration key.",
}

const messageArgument: HelpRow = {
  name: "MESSAGE",
  description: "Message to send to the claw.",
}

const shellArgument: HelpRow = {
  name: "SHELL",
  description: "Shell target. Defaults to the current SHELL when omitted.",
}

const installCommand: HelpEntry = {
  name: "install",
  summary: "Install a claw into the clawctl store for the selected runtime backend.",
  usage: "clawctl install [OPTIONS] TARGET",
  args: [targetArgument],
  options: [runtimeOption, helpOption],
  examples: ["clawctl install openclaw", "clawctl install openclaw@2026.3.7"],
}

const uninstallCommand: HelpEntry = {
  name: "uninstall",
  summary: "Remove installed claw versions from the local store.",
  usage: "clawctl uninstall [OPTIONS] TARGET",
  args: [targetArgument],
  options: [
    { name: "--all", description: "Remove every installed version of the selected claw." },
    runtimeOption,
    helpOption,
  ],
  examples: ["clawctl uninstall openclaw@2026.3.7", "clawctl uninstall --all openclaw"],
}

const useCommand: HelpEntry = {
  name: "use",
  summary: "Switch the active claw, installing it first if needed.",
  usage: "clawctl use [OPTIONS] TARGET",
  args: [targetArgument],
  options: [runtimeOption, helpOption],
  examples: ["clawctl use openclaw", "clawctl use openclaw@2026.3.7"],
}

const currentCommand: HelpEntry = {
  name: "current",
  summary: "Show the active claw.",
  usage: "clawctl current",
  options: [helpOption],
  examples: ["clawctl current"],
}

const listCommand: HelpEntry = {
  name: "list",
  summary: "List supported claws, or only claws installed locally.",
  usage: "clawctl list [OPTIONS]",
  options: [
    { name: "--installed", description: "Show only locally installed versions instead of the full registry." },
    helpOption,
  ],
  examples: ["clawctl list", "clawctl list --installed"],
}

const versionsCommand: HelpEntry = {
  name: "versions",
  summary: "List installable versions for a claw.",
  usage: "clawctl versions TARGET",
  args: [targetArgument],
  options: [helpOption],
  examples: ["clawctl versions openclaw", "clawctl versions picoclaw"],
}

const statusCommand: HelpEntry = {
  name: "status",
  summary: "Show install and runtime status for a claw.",
  usage: "clawctl status [TARGET]",
  args: [optionalTargetArgument],
  options: [helpOption],
  examples: ["clawctl status", "clawctl status openclaw@2026.3.7"],
}

const pingCommand: HelpEntry = {
  name: "ping",
  summary: "Send the built-in ping check to a claw.",
  usage: "clawctl ping [TARGET]",
  args: [optionalTargetArgument],
  options: [helpOption],
  examples: ["clawctl ping", "clawctl ping openclaw"],
}

const chatCommand: HelpEntry = {
  name: "chat",
  summary: "Send a message to a claw and print the reply.",
  usage: "clawctl chat MESSAGE [TARGET]",
  args: [messageArgument, optionalTargetArgument],
  options: [helpOption],
  examples: [
    'clawctl chat "Summarize the current workspace."',
    'clawctl chat "Reply with one sentence." openclaw@2026.3.7',
  ],
}

const stopCommand: HelpEntry = {
  name: "stop",
  summary: "Stop a managed claw runtime for the active or selected claw.",
  usage: "clawctl stop [OPTIONS] [TARGET]",
  args: [optionalTargetArgument],
  options: [runtimeOption, helpOption],
  examples: ["clawctl stop", "clawctl stop openclaw"],
}

const doctorCommand: HelpEntry = {
  name: "doctor",
  summary: "Run install, config, adapter, and runtime checks.",
  usage: "clawctl doctor [TARGET]",
  args: [optionalTargetArgument],
  options: [helpOption],
  examples: ["clawctl doctor", "clawctl doctor openclaw"],
}

const cleanupCommand: HelpEntry = {
  name: "cleanup",
  summary: "Remove stale installs, orphaned runtimes, and invalid active selections.",
  usage: "clawctl cleanup [TARGET]",
  args: [{ name: "TARGET", description: "Claw implementation to clean up. Uses the active claw when omitted." }],
  options: [helpOption],
  examples: ["clawctl cleanup", "clawctl cleanup openclaw"],
}

const configGetCommand: HelpEntry = {
  name: "get",
  summary: "Print a shared configuration value.",
  usage: "clawctl config get KEY",
  args: [keyArgument],
  options: [helpOption],
  examples: ["clawctl config get CLAW_MODEL", "clawctl config get CLAW_BASE_URL"],
}

const configSetCommand: HelpEntry = {
  name: "set",
  summary: "Store a shared configuration value.",
  usage: "clawctl config set KEY VALUE",
  args: [keyArgument, valueArgument],
  options: [helpOption],
  examples: ["clawctl config set CLAW_MODEL moonshotai/kimi-k2.5", "clawctl config set CLAW_API_KEY sk-..."],
}

const configCommand: HelpEntry = {
  name: "config",
  summary: "Read or update shared clawctl configuration.",
  usage: "clawctl config COMMAND",
  options: [helpOption],
  examples: ["clawctl config get CLAW_MODEL", "clawctl config set CLAW_API_KEY sk-..."],
  subcommands: [configGetCommand, configSetCommand],
}

const initCommand: HelpEntry = {
  name: "init",
  summary: "Add clawctl shims to your shell PATH setup.",
  usage: "clawctl init [SHELL]",
  args: [shellArgument],
  options: [helpOption],
  examples: ["clawctl init", "clawctl init fish"],
}

const rootCommandGroups: ReadonlyArray<HelpGroup> = [
  {
    title: "Core Commands",
    entries: [installCommand, uninstallCommand, useCommand, currentCommand, listCommand, versionsCommand],
  },
  {
    title: "Runtime Commands",
    entries: [statusCommand, pingCommand, chatCommand, stopCommand, doctorCommand, cleanupCommand],
  },
  {
    title: "Config Commands",
    entries: [configCommand, initCommand],
  },
]

const helpRoot: HelpEntry = {
  name: "clawctl",
  summary: "Manage installed claw runtimes and the active claw.",
  usage: "clawctl [OPTIONS] COMMAND",
  options: [helpOption, versionOption],
  examples: [
    "clawctl install openclaw",
    "clawctl use openclaw@2026.3.7",
    'clawctl chat "Summarize the current workspace."',
    "clawctl status",
  ],
  subcommands: rootCommandGroups.flatMap((group) => group.entries),
  commandGroups: rootCommandGroups,
}

const helpDefinitions = new Map<string, HelpEntry>([
  ["", helpRoot],
  ["install", installCommand],
  ["uninstall", uninstallCommand],
  ["use", useCommand],
  ["current", currentCommand],
  ["list", listCommand],
  ["versions", versionsCommand],
  ["status", statusCommand],
  ["ping", pingCommand],
  ["chat", chatCommand],
  ["stop", stopCommand],
  ["doctor", doctorCommand],
  ["cleanup", cleanupCommand],
  ["config", configCommand],
  ["config/get", configGetCommand],
  ["config/set", configSetCommand],
  ["init", initCommand],
])

function bold(value: string): string {
  return `\u001B[1m${value}\u001B[0m`
}

function header(value: string): string {
  return `\u001B[1m\u001B[4m${value}:\u001B[0m`
}

function renderRows(items: ReadonlyArray<HelpRow>, styleNames = false): string[] {
  const width = items.reduce((max, item) => Math.max(max, item.name.length), 0)
  return items.map((item) => {
    const label = styleNames ? bold(item.name.padEnd(width)) : item.name.padEnd(width)
    return `  ${label}  ${item.description}`
  })
}

function renderEntryRows(items: ReadonlyArray<HelpEntry>): string[] {
  return renderRows(
    items.map((item) => ({
      name: item.name,
      description: item.summary,
    })),
    true,
  )
}

export function getHelpSummary(path: HelpPath): string {
  return helpDefinitions.get(path.join("/"))?.summary ?? helpRoot.summary
}

export function resolveHelpPath(args: ReadonlyArray<string>): HelpPath | undefined {
  if (args.length === 0) {
    return []
  }

  const filtered = args.filter((arg) => arg !== "--help" && arg !== "-h")
  const wantsHelp = filtered.length !== args.length
  if (!wantsHelp) {
    return undefined
  }

  if (filtered.length >= 2 && helpDefinitions.has(`${filtered[0]}/${filtered[1]}`)) {
    return [filtered[0] ?? "", filtered[1] ?? ""]
  }
  if (filtered.length >= 1 && helpDefinitions.has(filtered[0] ?? "")) {
    return [filtered[0] ?? ""]
  }
  return []
}

export function renderHelp(path: HelpPath, version: string): string {
  const key = path.join("/")
  const definition = helpDefinitions.get(key) ?? helpRoot

  const lines: string[] = []
  lines.push(`clawctl ${version}`)
  lines.push("")
  lines.push(definition.summary)
  lines.push("")
  lines.push(header("Usage"))
  lines.push(`  ${definition.usage}`)

  if (definition.commandGroups && definition.commandGroups.length > 0) {
    for (const group of definition.commandGroups) {
      lines.push("")
      lines.push(header(group.title))
      lines.push(...renderEntryRows(group.entries))
    }
  } else if (definition.subcommands && definition.subcommands.length > 0) {
    lines.push("")
    lines.push(header("Commands"))
    lines.push(...renderEntryRows(definition.subcommands))
  }

  if (definition.args && definition.args.length > 0) {
    lines.push("")
    lines.push(header("Arguments"))
    lines.push(...renderRows(definition.args, true))
  }

  if (definition.options && definition.options.length > 0) {
    lines.push("")
    lines.push(header(key.length === 0 ? "Global Options" : "Options"))
    lines.push(...renderRows(definition.options, true))
  }

  if (definition.examples && definition.examples.length > 0) {
    lines.push("")
    lines.push(header("Examples"))
    for (const example of definition.examples) {
      lines.push(`  ${example}`)
    }
  }

  if (key.length === 0) {
    lines.push("")
    lines.push("Use 'clawctl COMMAND --help' for more information about a command.")
  }

  return `${lines.join("\n")}\n`
}
