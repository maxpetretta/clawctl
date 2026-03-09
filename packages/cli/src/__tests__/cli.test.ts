import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type AssetRecord = {
  contentType: string
  data: Uint8Array
}

const assetMap = new Map<string, AssetRecord>()

let apiOrigin = ""
let supportRoot = ""
let fakeDockerPath = ""
let fakeGitPath = ""
let fakeNpmPath = ""
let fakeUvPath = ""
let server: Server | undefined
const tempRoots = new Set<string>()

async function createResponseScript(
  destination: string,
  outputMode: "plain" | "openclaw-json",
  binaryName: string,
): Promise<void> {
  const daemonCases =
    binaryName === "nullclaw"
      ? `if [ "$1" = "gateway" ]; then
  mkdir -p "\${CLAWCTL_STATE_DIR}"
  touch "\${CLAWCTL_STATE_DIR}/ready"
  trap 'rm -f "\${CLAWCTL_STATE_DIR}/ready"; exit 0' TERM INT
  while true; do
    sleep 1
  done
fi

if [ "$1" = "status" ]; then
  if [ -f "\${CLAWCTL_STATE_DIR}/ready" ]; then
    exit 0
  fi
  exit 1
fi
`
      : binaryName === "picoclaw"
        ? `if [ "$1" = "gateway" ]; then
  mkdir -p "\${CLAWCTL_STATE_DIR}"
  touch "\${CLAWCTL_STATE_DIR}/ready"
  trap 'rm -f "\${CLAWCTL_STATE_DIR}/ready"; exit 0' TERM INT
  while true; do
    sleep 1
  done
fi

if [ "$1" = "status" ]; then
  if [ -f "\${CLAWCTL_STATE_DIR}/ready" ]; then
    exit 0
  fi
  exit 1
fi
`
        : binaryName === "zeroclaw"
          ? `if [ "$1" = "daemon" ]; then
  mkdir -p "\${CLAWCTL_STATE_DIR}"
  touch "\${CLAWCTL_STATE_DIR}/ready"
  trap 'rm -f "\${CLAWCTL_STATE_DIR}/ready"; exit 0' TERM INT
  while true; do
    sleep 1
  done
fi

if [ "$1" = "status" ]; then
  if [ -f "\${CLAWCTL_STATE_DIR}/ready" ]; then
    exit 0
  fi
  exit 1
fi
`
          : ""
  const source =
    outputMode === "openclaw-json"
      ? `#!/bin/sh
${daemonCases}
message=""
last=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ] || [ "$prev" = "-m" ]; then
    message="$arg"
  fi
  prev="$arg"
  last="$arg"
done
if [ -z "$message" ]; then
  message="$last"
fi
if [ "$message" = "Reply with exactly the single word pong." ]; then
  value="pong"
else
  value="reply:$message"
fi
printf '{"response":{"text":"%s"}}\n' "$value"
`
      : `#!/bin/sh
${daemonCases}
if [ "$1" = "agent" ]; then
  shift
fi
message=""
last=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ] || [ "$prev" = "-m" ]; then
    message="$arg"
  fi
  prev="$arg"
  last="$arg"
done
if [ -z "$message" ]; then
  message="$last"
fi
if [ "$message" = "Reply with exactly the single word pong." ]; then
  echo "pong"
else
  echo "reply:$message"
fi
`

  await writeFile(destination, source, "utf8")
  await execFileAsync("chmod", ["755", destination])
}

async function createTarGz(
  binaryName: string,
  options?: {
    nestedRoot?: string
  },
): Promise<Uint8Array> {
  const workDir = await mkdtemp(join(tmpdir(), `clawctl-${binaryName}-`))
  const baseDir = options?.nestedRoot ? join(workDir, options.nestedRoot) : workDir
  await mkdir(baseDir, { recursive: true })
  const scriptPath = join(baseDir, binaryName)
  const archivePath = join(workDir, `${binaryName}.tar.gz`)
  await createResponseScript(scriptPath, "plain", binaryName)
  const archiveTarget = options?.nestedRoot ? options.nestedRoot : binaryName
  await execFileAsync("tar", ["-czf", archivePath, "-C", workDir, archiveTarget])
  const data = await Bun.file(archivePath).bytes()
  await rm(workDir, { recursive: true, force: true })
  return data
}

async function createChecksumFile(assetName: string, assetData: Uint8Array, outputName: string): Promise<Uint8Array> {
  const workDir = await mkdtemp(join(tmpdir(), "clawctl-checksum-"))
  const assetPath = join(workDir, assetName)
  const checksumPath = join(workDir, outputName)
  await writeFile(assetPath, assetData)
  const { stdout } = await execFileAsync("shasum", ["-a", "256", assetPath])
  const line = stdout.replace(assetPath, assetName)
  await writeFile(checksumPath, line, "utf8")
  const data = await Bun.file(checksumPath).bytes()
  await rm(workDir, { recursive: true, force: true })
  return data
}

async function createGithubFixtures(): Promise<void> {
  const nullclawDir = await mkdtemp(join(tmpdir(), "clawctl-nullclaw-"))
  const nullclawPath = join(nullclawDir, "nullclaw-macos-aarch64.bin")
  await createResponseScript(nullclawPath, "plain", "nullclaw")
  assetMap.set("/downloads/nullclaw/nullclaw-macos-aarch64.bin", {
    contentType: "application/octet-stream",
    data: await Bun.file(nullclawPath).bytes(),
  })

  const picoclawArchive = await createTarGz("picoclaw")
  assetMap.set("/downloads/picoclaw/picoclaw_Darwin_arm64.tar.gz", {
    contentType: "application/gzip",
    data: picoclawArchive,
  })
  assetMap.set("/downloads/picoclaw/picoclaw_0.2.0_checksums.txt", {
    contentType: "text/plain",
    data: await createChecksumFile("picoclaw_Darwin_arm64.tar.gz", picoclawArchive, "picoclaw_0.2.0_checksums.txt"),
  })

  const zeroclawArchive = await createTarGz("zeroclaw")
  assetMap.set("/downloads/zeroclaw/zeroclaw-aarch64-apple-darwin.tar.gz", {
    contentType: "application/gzip",
    data: zeroclawArchive,
  })
  assetMap.set("/downloads/zeroclaw/SHA256SUMS", {
    contentType: "text/plain",
    data: await createChecksumFile("zeroclaw-aarch64-apple-darwin.tar.gz", zeroclawArchive, "SHA256SUMS"),
  })

  const ironclawArchive = await createTarGz("ironclaw", { nestedRoot: "ironclaw-aarch64-apple-darwin" })
  assetMap.set("/downloads/ironclaw/ironclaw-aarch64-apple-darwin.tar.gz", {
    contentType: "application/gzip",
    data: ironclawArchive,
  })
}

async function createFakeInstallers(root: string): Promise<void> {
  const binDir = join(root, "fake-bin")
  const repoDir = join(root, "fake-repos")
  fakeDockerPath = join(binDir, "docker")
  fakeGitPath = join(binDir, "git")
  fakeNpmPath = join(binDir, "npm")
  fakeUvPath = join(binDir, "uv")
  await mkdir(binDir, { recursive: true })
  await mkdir(join(repoDir, "nanoclaw"), { recursive: true })
  await mkdir(join(repoDir, "bitclaw"), { recursive: true })
  await mkdir(join(repoDir, "hermes"), { recursive: true })
  await mkdir(join(repoDir, "hermes", "mini-swe-agent"), { recursive: true })
  await mkdir(join(repoDir, "hermes", "tinker-atropos"), { recursive: true })
  await writeFile(join(repoDir, "nanoclaw", "README.md"), "# nanoclaw fixture\n", "utf8")
  await writeFile(join(repoDir, "bitclaw", "README.md"), "# bitclaw fixture\n", "utf8")
  await writeFile(join(repoDir, "hermes", "README.md"), "# hermes fixture\n", "utf8")
  await writeFile(join(repoDir, "hermes", "package.json"), '{ "name": "hermes-agent-fixture" }\n', "utf8")
  await writeFile(
    join(repoDir, "hermes", "mini-swe-agent", "pyproject.toml"),
    "[project]\nname='mini-swe-agent'\n",
    "utf8",
  )
  await writeFile(
    join(repoDir, "hermes", "tinker-atropos", "pyproject.toml"),
    "[project]\nname='tinker-atropos'\n",
    "utf8",
  )

  await writeFile(
    fakeNpmPath,
    `#!/bin/sh
repo_name=""
if [ -n "$PWD" ]; then
  repo_name=$(basename "$PWD")
fi
  if [ "$repo_name" = "repo" ] && [ -f "$PWD/README.md" ]; then
    case "$(cat "$PWD/README.md")" in
      *nanoclaw*)
        repo_name="nanoclaw"
        ;;
      *bitclaw*)
        repo_name="bitclaw"
        ;;
      *hermes*)
        repo_name="hermes"
        ;;
    esac
  fi

if [ "$1" = "view" ] && [ "$2" = "openclaw" ] && [ "$3" = "version" ] && [ "$4" = "--json" ]; then
  echo '"2026.3.7"'
  exit 0
fi

if [ "$1" = "view" ] && [ "$2" = "openclaw" ] && [ "$3" = "versions" ] && [ "$4" = "--json" ]; then
  echo '["2026.3.7","2026.3.6"]'
  exit 0
fi

if [ "$1" = "install" ]; then
  if [ "$repo_name" = "hermes" ] && [ "$2" = "--silent" ]; then
    mkdir -p "$PWD/node_modules/.bin"
    exit 0
  fi

  prefix=""
  spec=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --prefix)
        prefix="$2"
        shift 2
        ;;
      --no-save)
        shift
        ;;
      install)
        shift
        ;;
      *)
        spec="$1"
        shift
        ;;
    esac
  done

  if [ -z "$prefix" ] || [ -z "$spec" ]; then
    echo "missing prefix or spec" >&2
    exit 1
  fi

  mkdir -p "$prefix/node_modules/.bin"

  case "$spec" in
    openclaw@*)
      cat > "$prefix/node_modules/.bin/openclaw" <<'EOF'
#!/bin/sh
if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then
  mkdir -p "\${OPENCLAW_STATE_DIR}"
  touch "\${OPENCLAW_STATE_DIR}/ready"
  port="28789"
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--port" ]; then
      port="$arg"
    fi
    prev="$arg"
  done
  trap 'rm -f "\${OPENCLAW_STATE_DIR}/ready"; exit 0' TERM INT
  exec node -e 'const http=require("http"); const fs=require("fs"); const stateDir=process.argv[1]; const port=Number(process.argv[2]); const server=http.createServer((_req,res)=>{ res.statusCode=200; res.end("ok");}); server.listen(port, "127.0.0.1"); const shutdown=()=>{ try{ fs.rmSync(stateDir + "/ready", { force: true }); }catch{} server.close(()=>process.exit(0)); }; process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);' "\${OPENCLAW_STATE_DIR}" "$port"
fi

if [ "$1" = "gateway" ] && [ "$2" = "health" ]; then
  if [ -f "\${OPENCLAW_STATE_DIR}/ready" ]; then
    echo '{"state":"running"}'
    exit 0
  fi
  echo '{"state":"starting"}' >&2
  exit 1
fi

message=""
last=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ] || [ "$prev" = "-m" ]; then
    message="$arg"
  fi
  prev="$arg"
  last="$arg"
done
if [ -z "$message" ]; then
  message="$last"
fi
if [ "$message" = "Reply with exactly the single word pong." ]; then
  value="pong"
else
  value="reply:$message"
fi
printf '{"response":{"text":"%s"}}\n' "$value"
EOF
      chmod 755 "$prefix/node_modules/.bin/openclaw"
      exit 0
      ;;
  esac
fi

if [ "$1" = "ci" ]; then
  case "$repo_name" in
    nanoclaw)
      mkdir -p "$PWD/node_modules"
      exit 0
      ;;
    bitclaw)
      mkdir -p "$PWD/node_modules/tsx/dist"
      cat > "$PWD/node_modules/tsx/dist/cli.mjs" <<'EOF'
#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
const homeDir = process.env.BITCLAW_HOME || process.env.HOME || process.cwd()
const inboundDir = path.join(homeDir, "ipc", "inbound")
const outboundDir = path.join(homeDir, "ipc", "outbound")
const archiveDir = path.join(homeDir, "ipc", "archive")
fs.mkdirSync(inboundDir, { recursive: true })
fs.mkdirSync(outboundDir, { recursive: true })
fs.mkdirSync(archiveDir, { recursive: true })
const writeOutbound = (payload) => {
  const unixSeconds = Math.floor(Date.now() / 1000)
  const rand7 = Math.random().toString(36).slice(2, 9).padEnd(7, "0").slice(0, 7)
  const finalPath = path.join(outboundDir, \`\${unixSeconds}_out_\${rand7}.json\`)
  const tmpPath = \`\${finalPath}.tmp\`
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2))
  fs.renameSync(tmpPath, finalPath)
}
const pollInbound = () => {
  const files = fs.readdirSync(inboundDir).filter((file) => file.endsWith(".json")).sort()
  for (const file of files) {
    const filePath = path.join(inboundDir, file)
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
      if (parsed.type === "messages" && typeof parsed.text === "string") {
        const value = parsed.text === "Reply with exactly the single word pong." ? "pong" : \`reply:\${parsed.text}\`
        writeOutbound({
          type: "result",
          status: "success",
          result: value,
          timestamp: new Date().toISOString(),
        })
      }
    } catch {}
    try {
      fs.renameSync(filePath, path.join(archiveDir, file))
    } catch {}
  }
}
const cleanup = () => {
  try {
    fs.rmSync(path.join(homeDir, "ipc"), { recursive: true, force: true })
  } catch {}
  process.exit(0)
}
process.on("SIGTERM", cleanup)
process.on("SIGINT", cleanup)
setInterval(pollInbound, 100)
setInterval(() => {}, 1000)
EOF
      chmod 755 "$PWD/node_modules/tsx/dist/cli.mjs"
      exit 0
      ;;
  esac
fi

if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  case "$repo_name" in
    nanoclaw)
      mkdir -p "$PWD/dist"
      cat > "$PWD/dist/index.js" <<'EOF'
const fs = require("fs")
const path = require("path")
const ipcDir = path.join(__dirname, "..", "data", "ipc")
fs.mkdirSync(ipcDir, { recursive: true })
const cleanup = () => {
  try {
    fs.rmSync(ipcDir, { recursive: true, force: true })
  } catch {}
  process.exit(0)
}
process.on("SIGTERM", cleanup)
process.on("SIGINT", cleanup)
setInterval(() => {}, 1000)
EOF
      exit 0
      ;;
  esac
fi

echo "unsupported npm invocation: $*" >&2
exit 1
`,
    "utf8",
  )

  await writeFile(
    fakeUvPath,
    `#!/bin/sh
if [ "$1" = "venv" ]; then
  venv_dir="$2"
  if [ -z "$venv_dir" ]; then
    echo "missing venv dir" >&2
    exit 1
  fi
  mkdir -p "$venv_dir/bin"
  cat > "$venv_dir/bin/python" <<'EOF'
#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "hermes_cli.main" ]; then
  shift 2
  if [ "$1" = "gateway" ] && [ "$2" = "run" ]; then
    mkdir -p "\${HERMES_HOME}"
    touch "\${HERMES_HOME}/gateway-ready"
    trap 'rm -f "\${HERMES_HOME}/gateway-ready"; exit 0' TERM INT
    while true; do
      sleep 1
    done
  fi

  if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then
    if [ -f "\${HERMES_HOME}/gateway-ready" ]; then
      exit 0
    fi
    exit 1
  fi
fi

if [ "\${1##*/}" = "clawctl-hermes-chat.py" ]; then
  message="$2"
  if [ "$message" = "Reply with exactly the single word pong." ]; then
    echo "pong"
  else
    echo "reply:$message"
  fi
  exit 0
fi

exit 0
EOF
  chmod 755 "$venv_dir/bin/python"
  exit 0
fi

if [ "$1" = "pip" ] && [ "$2" = "install" ]; then
  python_bin=""
  spec=""
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --python)
        python_bin="$2"
        shift 2
        ;;
      *)
        spec="$1"
        shift
        ;;
    esac
  done

  if [ -z "$python_bin" ] || [ -z "$spec" ]; then
    echo "missing python bin or spec" >&2
    exit 1
  fi

  tool_dir=$(dirname "$python_bin")

  case "$spec" in
    nanobot-ai==*)
      cat > "$tool_dir/nanobot" <<'EOF'
#!/bin/sh
if [ "$1" = "gateway" ]; then
  port="28080"
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--port" ]; then
      port="$arg"
    fi
    prev="$arg"
  done
  exec node -e 'setInterval(() => {}, 1000); const shutdown=()=>process.exit(0); process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);' "$port"
fi

message=""
last=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--message" ] || [ "$prev" = "-m" ]; then
    message="$arg"
  fi
  prev="$arg"
  last="$arg"
done
if [ -z "$message" ]; then
  message="$last"
fi
if [ "$message" = "Reply with exactly the single word pong." ]; then
  echo "pong"
else
  echo "reply:$message"
fi
EOF
      chmod 755 "$tool_dir/nanobot"
      exit 0
      ;;
    .|".[all]"|./mini-swe-agent|./tinker-atropos)
      exit 0
      ;;
  esac
fi

echo "unsupported uv invocation: $*" >&2
exit 1
`,
    "utf8",
  )

  await writeFile(
    fakeGitPath,
    `#!/bin/sh
if [ "$1" = "clone" ]; then
  repo=""
  dest=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      clone|--depth|1|--branch|main)
        shift
        ;;
      *)
        if [ -z "$repo" ]; then
          repo="$1"
        elif [ -z "$dest" ]; then
          dest="$1"
        fi
        shift
        ;;
    esac
  done

  case "$repo" in
    https://github.com/qwibitai/nanoclaw.git)
      source_dir="${repoDir}/nanoclaw"
      ;;
    https://github.com/NickTikhonov/bitclaw.git)
      source_dir="${repoDir}/bitclaw"
      ;;
    https://github.com/NousResearch/hermes-agent.git)
      source_dir="${repoDir}/hermes"
      ;;
    *)
      echo "unsupported repo: $repo" >&2
      exit 1
      ;;
  esac

  mkdir -p "$dest"
  cp -R "$source_dir"/. "$dest"/
  exit 0
fi

if [ "$1" = "ls-remote" ] && [ "$2" = "--tags" ] && [ "$3" = "--refs" ]; then
  case "$4" in
    https://github.com/rcarmo/piclaw.git)
      printf '1111111111111111111111111111111111111111\trefs/tags/v0.3.0\n'
      printf '2222222222222222222222222222222222222222\trefs/tags/v0.2.9\n'
      exit 0
      ;;
  esac
fi

if [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then
  exit 0
fi

if [ "$1" = "-C" ] && [ "$3" = "submodule" ] && [ "$4" = "update" ]; then
  exit 0
fi

echo "unsupported git invocation: $*" >&2
exit 1
`,
    "utf8",
  )

  await writeFile(
    fakeDockerPath,
    `#!/bin/sh
exit 0
`,
    "utf8",
  )

  await execFileAsync("chmod", ["755", fakeNpmPath])
  await execFileAsync("chmod", ["755", fakeUvPath])
  await execFileAsync("chmod", ["755", fakeGitPath])
  await execFileAsync("chmod", ["755", fakeDockerPath])
}

function createTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clawctl-root-")).then((root) => {
    tempRoots.add(root)
    return root
  })
}

async function stopManagedProcesses(root: string): Promise<void> {
  const runtimeRoot = join(root, "runtimes", "local")
  try {
    const implementations = await readdir(runtimeRoot)
    for (const implementation of implementations) {
      const implementationDir = join(runtimeRoot, implementation)
      const versions = await readdir(implementationDir)
      for (const version of versions) {
        const metadataPath = join(implementationDir, version, "runtime.json")
        try {
          const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as { pid?: number }
          if (typeof parsed.pid === "number") {
            try {
              process.kill(parsed.pid, "SIGTERM")
            } catch {
              // Ignore cleanup races with already-exited processes.
            }
          }
        } catch {
          // Ignore malformed or missing runtime metadata during cleanup.
        }
      }
    }
  } catch {
    // Ignore missing runtime directories during cleanup.
  }
}

async function cleanupRoot(root: string): Promise<void> {
  tempRoots.delete(root)
  await stopManagedProcesses(root)
  await rm(root, { recursive: true, force: true })
}

function runCli(root: string, args: string[]): Promise<string> {
  return runCliWithEnv(root, args, {})
}

async function runCliWithEnv(root: string, args: string[], envOverrides: Record<string, string>): Promise<string> {
  const cliRoot = resolve(import.meta.dir, "../..")
  const { stdout } = await execFileAsync("bun", ["run", "src/index.ts", ...args], {
    cwd: cliRoot,
    env: {
      ...process.env,
      CLAWCTL_ROOT: root,
      CLAWCTL_GITHUB_API_ORIGIN: apiOrigin,
      CLAWCTL_PYPI_API_ORIGIN: apiOrigin,
      CLAWCTL_DOCKER_BIN: fakeDockerPath,
      CLAWCTL_GIT_BIN: fakeGitPath,
      CLAWCTL_NPM_BIN: fakeNpmPath,
      CLAWCTL_UV_BIN: fakeUvPath,
      ...envOverrides,
    },
  })

  return stdout.trim()
}

function runCliExpectFailure(root: string, args: string[]): Promise<string> {
  return runCliExpectFailureWithEnv(root, args, {})
}

async function runCliExpectFailureWithEnv(
  root: string,
  args: string[],
  envOverrides: Record<string, string>,
): Promise<string> {
  try {
    await runCliWithEnv(root, args, envOverrides)
  } catch (error) {
    if (!(error instanceof Error && "stderr" in error)) {
      throw error
    }
    const stdout = String("stdout" in error ? error.stdout : "").trim()
    const stderr = String(error.stderr ?? "").trim()
    const combined = `${stdout}\n${stderr}`.trim()
    if (combined.length > 0) {
      return combined
    }
    return String(error.message)
  }

  throw new Error("expected command to fail")
}

async function seedSharedConfig(root: string): Promise<void> {
  await runCli(root, ["config", "set", "CLAW_API_KEY", "test-key"])
  await runCli(root, ["config", "set", "CLAW_BASE_URL", "http://127.0.0.1:9999/v1"])
  await runCli(root, ["config", "set", "CLAW_MODEL", "test-model"])
}

async function seedTelegramConfig(root: string): Promise<void> {
  await runCli(root, ["config", "set", "TELEGRAM_BOT_TOKEN", "telegram-token"])
  await runCli(root, ["config", "set", "TELEGRAM_BOT_USERNAME", "clawctl_bot"])
  await runCli(root, ["config", "set", "TELEGRAM_CHAT_ID", "12345"])
  await runCli(root, ["config", "set", "TELEGRAM_ALLOWED_FROM", "12345,67890"])
}

beforeAll(async () => {
  supportRoot = await mkdtemp(join(tmpdir(), "clawctl-support-"))
  await createGithubFixtures()
  await createFakeInstallers(supportRoot)

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    const path = url.pathname

    if (path === "/repos/nullclaw/nullclaw/releases/tags/v2026.3.7") {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          tag_name: "v2026.3.7",
          assets: [
            {
              name: "nullclaw-macos-aarch64.bin",
              browser_download_url: `${apiOrigin}/downloads/nullclaw/nullclaw-macos-aarch64.bin`,
            },
          ],
        }),
      )
      return
    }

    if (path === "/repos/nullclaw/nullclaw/releases") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify([{ tag_name: "v2026.3.7" }, { tag_name: "v2026.3.6" }]))
      return
    }

    if (path === "/repos/sipeed/picoclaw/releases/tags/v0.2.0") {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          tag_name: "v0.2.0",
          assets: [
            {
              name: "picoclaw_Darwin_arm64.tar.gz",
              browser_download_url: `${apiOrigin}/downloads/picoclaw/picoclaw_Darwin_arm64.tar.gz`,
            },
            {
              name: "picoclaw_0.2.0_checksums.txt",
              browser_download_url: `${apiOrigin}/downloads/picoclaw/picoclaw_0.2.0_checksums.txt`,
            },
          ],
        }),
      )
      return
    }

    if (path === "/repos/sipeed/picoclaw/releases") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify([{ tag_name: "v0.2.0" }, { tag_name: "v0.1.9" }]))
      return
    }

    if (path === "/repos/zeroclaw-labs/zeroclaw/releases/tags/v0.1.7") {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          tag_name: "v0.1.7",
          assets: [
            {
              name: "zeroclaw-aarch64-apple-darwin.tar.gz",
              browser_download_url: `${apiOrigin}/downloads/zeroclaw/zeroclaw-aarch64-apple-darwin.tar.gz`,
            },
            {
              name: "SHA256SUMS",
              browser_download_url: `${apiOrigin}/downloads/zeroclaw/SHA256SUMS`,
            },
          ],
        }),
      )
      return
    }

    if (path === "/repos/zeroclaw-labs/zeroclaw/releases") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify([{ tag_name: "v0.1.7" }, { tag_name: "v0.1.6" }]))
      return
    }

    if (path === "/repos/nearai/ironclaw/releases/tags/v0.9.0") {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          tag_name: "v0.9.0",
          assets: [
            {
              name: "ironclaw-aarch64-apple-darwin.tar.gz",
              browser_download_url: `${apiOrigin}/downloads/ironclaw/ironclaw-aarch64-apple-darwin.tar.gz`,
            },
          ],
        }),
      )
      return
    }

    if (path === "/repos/nearai/ironclaw/releases/latest") {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          tag_name: "v0.9.0",
          assets: [
            {
              name: "ironclaw-aarch64-apple-darwin.tar.gz",
              browser_download_url: `${apiOrigin}/downloads/ironclaw/ironclaw-aarch64-apple-darwin.tar.gz`,
            },
          ],
        }),
      )
      return
    }

    if (path === "/repos/nearai/ironclaw/releases") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify([{ tag_name: "v0.9.0" }, { tag_name: "v0.8.9" }]))
      return
    }

    if (path === "/pypi/nanobot-ai/json") {
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          info: { version: "0.1.4.post4" },
          releases: {
            "0.1.4.post4": [],
            "0.1.4.post3": [],
          },
        }),
      )
      return
    }

    const asset = assetMap.get(path)
    if (asset) {
      response.statusCode = 200
      response.setHeader("content-type", asset.contentType)
      response.end(asset.data)
      return
    }

    response.statusCode = 404
    response.end("not found")
  })

  await new Promise<void>((resolveReady) => {
    const activeServer = server
    if (!activeServer) {
      throw new Error("test server was not created")
    }

    activeServer.listen(0, "127.0.0.1", () => {
      const address = activeServer.address()
      if (!address || typeof address === "string") {
        throw new Error("failed to bind test server")
      }
      apiOrigin = `http://127.0.0.1:${address.port}`
      resolveReady()
    })
  })
})

afterAll(async () => {
  const activeServer = server
  if (activeServer) {
    await new Promise<void>((resolveClosed, reject) => {
      activeServer.close((error?: Error) => {
        if (error) {
          reject(error)
          return
        }
        resolveClosed()
      })
    })
  }
  for (const root of [...tempRoots]) {
    await cleanupRoot(root)
  }
  await rm(supportRoot, { recursive: true, force: true })
})

describe("tier 1 clawctl cli", () => {
  test("doctor validates the adapter registry", async () => {
    const root = await createTempRoot()
    try {
      const output = await runCliExpectFailure(root, ["doctor"])
      expect(output).toContain("ok: registry: adapter registry is valid")
      expect(output).toContain(`error: path:bin: add ${join(root, "bin")} to PATH to use active claw shims`)
      expect(output).toContain("doctor: failed")
    } finally {
      await cleanupRoot(root)
    }
  })

  test.each([
    ["nullclaw", "v2026.3.7"],
    ["picoclaw", "v0.2.0"],
    ["zeroclaw", "v0.1.7"],
  ])("installs and chats with %s", async (implementation, version) => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)

      const installOutput = await runCli(root, ["install", `${implementation}@${version}`])
      expect(installOutput).toContain(`installed ${implementation}@${version}`)

      const useOutput = await runCli(root, ["use", `${implementation}@${version}`])
      expect(useOutput).toContain(`using ${implementation}@${version}`)

      const currentOutput = await runCli(root, ["current"])
      expect(currentOutput).toContain(`${implementation}@${version}`)

      const pingOutput = await runCli(root, ["ping"])
      expect(pingOutput).toBe("pong")

      const chatOutput = await runCli(root, ["chat", "hello-world"])
      expect(chatOutput).toBe("reply:hello-world")

      const statusOutput = await runCli(root, ["status"])
      expect(statusOutput).toContain("supervision: native-daemon")
      expect(statusOutput).toContain("state: running")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("use can start nullclaw before shared credentials are configured", async () => {
    const root = await createTempRoot()
    try {
      const installOutput = await runCli(root, ["install", "nullclaw@v2026.3.7"])
      expect(installOutput).toContain("installed nullclaw@v2026.3.7")

      const useOutput = await runCli(root, ["use", "nullclaw@v2026.3.7"])
      expect(useOutput).toContain("using nullclaw@v2026.3.7")

      const statusOutput = await runCli(root, ["status"])
      expect(statusOutput).toContain("state: running")
    } finally {
      await cleanupRoot(root)
    }
  })

  test.each([
    ["/bin/zsh", "~/.zshrc"],
    ["/bin/bash", "~/.bashrc"],
    ["/opt/homebrew/bin/fish", "~/.config/fish/config.fish"],
  ])("use prints a shell-specific PATH hint for %s when shims are not on PATH", async (shell, configFile) => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)
      await runCli(root, ["install", "nullclaw@v2026.3.7"])

      const output = await runCliWithEnv(root, ["use", "nullclaw@v2026.3.7"], {
        PATH: process.env.PATH ?? "",
        SHELL: shell,
      })

      expect(output).toContain("using nullclaw@v2026.3.7")
      expect(output).toContain(`path hint: ${join(root, "bin")} is not on PATH`)
      expect(output).toContain(`add this to ${configFile}:`)
      expect(output).toContain(
        shell.endsWith("fish") ? `fish_add_path -U ${join(root, "bin")}` : `export PATH="${join(root, "bin")}:$PATH"`,
      )
      expect(output).toContain("or run: clawctl init")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("use warns when an earlier PATH entry shadows the active implementation shim", async () => {
    const root = await createTempRoot()
    const shadowDir = join(root, "shadow-bin")
    try {
      await seedSharedConfig(root)
      await mkdir(shadowDir, { recursive: true })
      await createResponseScript(join(shadowDir, "openclaw"), "plain", "openclaw")
      await runCli(root, ["install", "openclaw"])

      const output = await runCliWithEnv(root, ["use", "openclaw"], {
        PATH: `${shadowDir}:${join(root, "bin")}:${process.env.PATH ?? ""}`,
        SHELL: "/bin/zsh",
      })

      expect(output).toContain("using openclaw@2026.3.7")
      expect(output).toContain(`path warning: openclaw resolves to ${join(shadowDir, "openclaw")}`)
      expect(output).toContain(
        `move ${join(root, "bin")} earlier on PATH so openclaw uses ${join(root, "bin", "openclaw")}`,
      )
      expect(output).toContain("ensure this appears before other PATH setup in ~/.zshrc:")
      expect(output).toContain(`export PATH="${join(root, "bin")}:$PATH"`)
    } finally {
      await cleanupRoot(root)
    }
  })

  test("init autodetects the shell and appends a PATH line once", async () => {
    const root = await createTempRoot()
    const homeDir = join(root, "home")
    try {
      const firstOutput = await runCliWithEnv(root, ["init"], {
        HOME: homeDir,
        SHELL: "/bin/zsh",
      })
      const secondOutput = await runCliWithEnv(root, ["init"], {
        HOME: homeDir,
        SHELL: "/bin/zsh",
      })
      const configPath = join(homeDir, ".zshrc")
      const configText = await Bun.file(configPath).text()

      expect(firstOutput).toContain("init: wrote PATH setup to ~/.zshrc")
      expect(firstOutput).toContain(`export PATH="${join(root, "bin")}:$PATH"`)
      expect(secondOutput).toContain("init: already configured in ~/.zshrc")
      expect(configText).toBe(`export PATH="${join(root, "bin")}:$PATH"\n`)
    } finally {
      await cleanupRoot(root)
    }
  })

  test("init accepts an explicit fish shell target", async () => {
    const root = await createTempRoot()
    const homeDir = join(root, "home")
    try {
      const output = await runCliWithEnv(root, ["init", "fish"], {
        HOME: homeDir,
        SHELL: "/bin/zsh",
      })
      const configPath = join(homeDir, ".config", "fish", "config.fish")
      const configText = await Bun.file(configPath).text()

      expect(output).toContain("init: wrote PATH setup to ~/.config/fish/config.fish")
      expect(output).toContain(`fish_add_path -U ${join(root, "bin")}`)
      expect(configText).toBe(`fish_add_path -U ${join(root, "bin")}\n`)
    } finally {
      await cleanupRoot(root)
    }
  })

  test("use writes active shims and passes telegram config into the active claw", async () => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)
      await seedTelegramConfig(root)
      await runCli(root, ["install", "nullclaw@v2026.3.7"])

      const useOutput = await runCli(root, ["use", "nullclaw@v2026.3.7"])
      expect(useOutput).toContain("using nullclaw@v2026.3.7")

      const activeShim = join(root, "bin", "claw")
      const implementationShim = join(root, "bin", "nullclaw")
      const configText = await Bun.file(
        join(root, "runtimes", "local", "nullclaw", "v2026.3.7", "home", ".nullclaw", "config.json"),
      ).text()
      const { stdout } = await execFileAsync(implementationShim, ["agent", "-m", "hello-shim"], {
        env: {
          ...process.env,
          CLAWCTL_ROOT: root,
        },
      })

      expect(await Bun.file(activeShim).exists()).toBe(true)
      expect(await Bun.file(implementationShim).exists()).toBe(true)
      expect(configText).toContain('"telegram"')
      expect(configText).toContain('"bot_token": "telegram-token"')
      expect(configText).toContain('"allow_from": ["12345","67890"]')
      expect(stdout.trim()).toBe("reply:hello-shim")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("cleans stale partial installs and uninstalls the active claw", async () => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)
      const staleDir = join(root, "installs", "local", "nullclaw", "v2026.3.7.partial-stale")
      await mkdir(staleDir, { recursive: true })
      await writeFile(join(staleDir, "junk.txt"), "stale", "utf8")

      await runCli(root, ["install", "nullclaw@v2026.3.7"])
      expect(await Bun.file(staleDir).exists()).toBe(false)

      await runCli(root, ["use", "nullclaw@v2026.3.7"])
      const uninstallOutput = await runCli(root, ["uninstall", "nullclaw@v2026.3.7"])
      expect(uninstallOutput).toBe("uninstalled nullclaw@v2026.3.7")

      expect(await Bun.file(join(root, "installs", "local", "nullclaw", "v2026.3.7")).exists()).toBe(false)
      expect(await Bun.file(join(root, "runtimes", "local", "nullclaw", "v2026.3.7")).exists()).toBe(false)
      expect(await runCli(root, ["current"])).toBe("no active claw")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("cleanup removes stale runtime state and use auto-installs missing targets", async () => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)
      const staleRuntime = join(root, "runtimes", "local", "ghostclaw", "v1")
      await mkdir(staleRuntime, { recursive: true })

      const cleanupOutput = await runCli(root, ["cleanup"])
      expect(cleanupOutput).toContain("removed 0 partial installs, 1 orphaned runtimes")
      expect(await Bun.file(staleRuntime).exists()).toBe(false)

      const useOutput = await runCli(root, ["use", "openclaw"])
      expect(useOutput).toContain("using openclaw@2026.3.7")

      const currentOutput = await runCli(root, ["current"])
      expect(currentOutput).toContain("openclaw@2026.3.7")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("list shows simple installed state without support tiers", async () => {
    const root = await createTempRoot()
    try {
      await runCli(root, ["install", "nullclaw@v2026.3.7"])

      const output = await runCli(root, ["list"])
      expect(output).toContain("nullclaw: v2026.3.7")
      expect(output).toContain("openclaw: not installed")
      expect(output).toContain("hermes: not installed")
      expect(output).not.toContain("(tier")
      expect(output).not.toContain("  installed:")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("use starts a managed runtime, stop stops it, and switching claws stops the previous runtime", async () => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)
      await runCli(root, ["install", "nullclaw@v2026.3.7"])
      await runCli(root, ["install", "picoclaw@v0.2.0"])

      const firstUse = await runCli(root, ["use", "nullclaw@v2026.3.7"])
      expect(firstUse).toContain("using nullclaw@v2026.3.7")

      const firstStatus = await runCli(root, ["status"])
      expect(firstStatus).toContain("state: running")
      expect(firstStatus).toContain("pid:")
      expect(await Bun.file(join(root, "bin", "claw")).exists()).toBe(true)
      expect(await Bun.file(join(root, "bin", "nullclaw")).exists()).toBe(true)

      const stopOutput = await runCli(root, ["stop"])
      expect(stopOutput).toBe("stopped nullclaw@v2026.3.7")
      expect(await Bun.file(join(root, "bin", "claw")).exists()).toBe(false)
      expect(await Bun.file(join(root, "bin", "nullclaw")).exists()).toBe(false)

      const stoppedStatus = await runCli(root, ["status", "nullclaw@v2026.3.7"])
      expect(stoppedStatus).toContain("state: stopped")

      const secondUse = await runCli(root, ["use", "picoclaw@v0.2.0"])
      expect(secondUse).toContain("using picoclaw@v0.2.0")

      const newStatus = await runCli(root, ["status"])
      expect(newStatus).toContain("picoclaw@v0.2.0")
      expect(newStatus).toContain("state: running")
      expect(await Bun.file(join(root, "bin", "claw")).exists()).toBe(true)
      expect(await Bun.file(join(root, "bin", "picoclaw")).exists()).toBe(true)
      expect(await Bun.file(join(root, "bin", "nullclaw")).exists()).toBe(false)

      const oldStatus = await runCli(root, ["status", "nullclaw@v2026.3.7"])
      expect(oldStatus).toContain("state: stopped")
    } finally {
      await cleanupRoot(root)
    }
  }, 15_000)
})

describe("tier 2 clawctl cli", () => {
  const assertTier2ChatFlow = async (implementation: string, version: string) => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)

      const installOutput = await runCli(root, ["install", implementation])
      expect(installOutput).toContain(`installed ${implementation}@${version}`)

      const useOutput = await runCli(root, ["use", implementation])
      expect(useOutput).toContain(`using ${implementation}@${version}`)

      const currentOutput = await runCli(root, ["current"])
      expect(currentOutput).toContain(`${implementation}@${version}`)

      const pingOutput = await runCli(root, ["ping"])
      expect(pingOutput).toBe("pong")

      const chatOutput = await runCli(root, ["chat", "hello-tier2"])
      expect(chatOutput).toBe("reply:hello-tier2")

      const statusOutput = await runCli(root, ["status"])
      expect(statusOutput).toContain("supervision: native-daemon")
      expect(statusOutput).toContain("state: running")

      const installedOutput = await runCli(root, ["list", "--installed"])
      expect(installedOutput).toContain(`${implementation}@${version} *`)
    } finally {
      await cleanupRoot(root)
    }
  }

  test("installs latest and chats with openclaw", async () => {
    await assertTier2ChatFlow("openclaw", "2026.3.7")
  })

  test("installs latest and chats with nanobot", async () => {
    await assertTier2ChatFlow("nanobot", "0.1.4.post4")
  }, 15_000)

  test("uninstall --all removes every installed version", async () => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)

      await runCli(root, ["install", "openclaw@2026.3.6"])
      await runCli(root, ["install", "openclaw@2026.3.7"])

      const uninstallOutput = await runCli(root, ["uninstall", "--all", "openclaw"])
      expect(uninstallOutput).toBe("uninstalled 2 version(s) of openclaw")

      const installedOutput = await runCli(root, ["list", "--installed"])
      expect(installedOutput).not.toContain("openclaw@")
    } finally {
      await cleanupRoot(root)
    }
  })
})

describe("remote versions", () => {
  test.each([
    ["nullclaw", ["v2026.3.7", "v2026.3.6"]],
    ["openclaw", ["2026.3.7", "2026.3.6"]],
    ["nanobot", ["0.1.4.post4", "0.1.4.post3"]],
    ["hermes", ["main"]],
    ["nanoclaw", ["main"]],
    ["ironclaw", ["v0.9.0", "v0.8.9"]],
    ["piclaw", ["v0.3.0", "v0.2.9"]],
  ])("lists remote versions for %s", async (implementation, expectedVersions) => {
    const root = await createTempRoot()
    try {
      const output = await runCli(root, ["versions", implementation])
      expect(output.split("\n")).toEqual(expectedVersions)
    } finally {
      await cleanupRoot(root)
    }
  })

  test("rejects version-qualified targets", async () => {
    const root = await createTempRoot()
    try {
      const output = await runCliExpectFailure(root, ["versions", "openclaw@2026.3.7"])
      expect(output).toContain("versions target must not include a version")
    } finally {
      await cleanupRoot(root)
    }
  })
})

describe("tier 3 clawctl cli", () => {
  test("installs and chats with bootstrap-backed hermes", async () => {
    const root = await createTempRoot()
    try {
      await seedSharedConfig(root)

      const installOutput = await runCli(root, ["install", "hermes"])
      expect(installOutput).toContain("installed hermes@main")

      const useOutput = await runCli(root, ["use", "hermes"])
      expect(useOutput).toContain("using hermes@main")

      const currentOutput = await runCli(root, ["current"])
      expect(currentOutput).toContain("hermes@main")

      const pingOutput = await runCli(root, ["ping", "hermes"])
      expect(pingOutput).toBe("pong")

      const chatOutput = await runCli(root, ["chat", "hello-hermes", "hermes"])
      expect(chatOutput).toBe("reply:hello-hermes")

      const statusOutput = await runCli(root, ["status", "hermes@main"])
      expect(statusOutput).toContain("supervision: native-daemon")
      expect(statusOutput).toContain("state: running")
      expect(statusOutput).toContain("chat: yes")
      expect(statusOutput).toContain("ping: yes")

      const envText = await Bun.file(join(root, "runtimes", "local", "hermes", "main", "home", ".env")).text()
      expect(envText).toContain("OPENAI_BASE_URL=http://127.0.0.1:9999/v1")
      expect(envText).toContain("OPENAI_API_KEY=test-key")
      expect(envText).toContain("LLM_MODEL=test-model")

      const repoReadme = await readFile(join(root, "installs", "local", "hermes", "main", "repo", "README.md"), "utf8")
      expect(repoReadme).toContain("hermes")
    } finally {
      await cleanupRoot(root)
    }
  })

  test.each([
    ["nanoclaw", "main"],
    ["bitclaw", "main"],
    ["ironclaw", "v0.9.0"],
  ])("install-only local target %s rejects activation and interaction immediately", async (implementation, version) => {
    const root = await createTempRoot()
    try {
      const installOutput = await runCli(root, ["install", implementation])
      expect(installOutput).toContain(`installed ${implementation}@`)

      const useFailure = await runCliExpectFailure(root, ["use", implementation])
      expect(useFailure).toContain(`${implementation} is install-only in clawctl; it is not interactable or executable`)

      const chatFailure = await runCliExpectFailure(root, ["chat", "hello", implementation])
      expect(chatFailure).toContain(
        `${implementation} is install-only in clawctl; it is not interactable or executable`,
      )

      const pingFailure = await runCliExpectFailure(root, ["ping", implementation])
      expect(pingFailure).toContain(
        `${implementation} is install-only in clawctl; it is not interactable or executable`,
      )

      const stopFailure = await runCliExpectFailure(root, ["stop", implementation])
      expect(stopFailure).toContain(
        `${implementation} is install-only in clawctl; it is not interactable or executable`,
      )

      const statusOutput = await runCli(root, ["status", `${implementation}@${version}`])
      expect(statusOutput).toContain("supervision: unmanaged")
      expect(statusOutput).toContain("state: install-only")
      expect(statusOutput).toContain("chat: no")
      expect(statusOutput).toContain("ping: no")

      if (implementation === "nanoclaw" || implementation === "bitclaw") {
        const readmePath = join(root, "installs", "local", implementation, "main", "repo", "README.md")
        expect(await readFile(readmePath, "utf8")).toContain(implementation)
      }
    } finally {
      await cleanupRoot(root)
    }
  })

  test("install-only piclaw rejects activation and interaction without a local install path", async () => {
    const root = await createTempRoot()
    try {
      for (const command of [
        ["use", "piclaw"],
        ["chat", "hello", "piclaw"],
        ["ping", "piclaw"],
        ["stop", "piclaw"],
      ]) {
        const failure = await runCliExpectFailure(root, command)
        expect(failure).toContain("piclaw is install-only in clawctl; it is not interactable or executable")
      }
    } finally {
      await cleanupRoot(root)
    }
  })

  test("installs release-backed experimental ironclaw metadata", async () => {
    const root = await createTempRoot()
    try {
      const installOutput = await runCli(root, ["install", "ironclaw"])
      expect(installOutput).toContain("installed ironclaw@v0.9.0")

      const binaryPath = join(root, "installs", "local", "ironclaw", "v0.9.0", "bin", "ironclaw")
      expect(await Bun.file(binaryPath).exists()).toBe(true)

      const statusOutput = await runCli(root, ["status", "ironclaw@v0.9.0"])
      expect(statusOutput).toContain("supervision: unmanaged")
      expect(statusOutput).toContain("chat: no")

      const failureOutput = await runCliExpectFailure(root, ["use", "ironclaw"])
      expect(failureOutput).toContain("ironclaw is install-only in clawctl; it is not interactable or executable")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("doctor validates docker-first piclaw metadata", async () => {
    const root = await createTempRoot()
    try {
      const output = await runCliExpectFailure(root, ["doctor", "piclaw"])
      expect(output).toContain("ok: piclaw:docker:tool:")
      expect(output).toContain("doctor: failed")
    } finally {
      await cleanupRoot(root)
    }
  })

  test("doctor validates local install metadata for ironclaw", async () => {
    const root = await createTempRoot()
    try {
      const output = await runCliExpectFailure(root, ["doctor", "ironclaw"])
      expect(output).toContain("ok: ironclaw:local:tool:tar")
      expect(output).toContain("ok: ironclaw:install: not installed")
      expect(output).toContain("doctor: failed")
    } finally {
      await cleanupRoot(root)
    }
  })
})
