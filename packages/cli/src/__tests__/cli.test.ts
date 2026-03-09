import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

async function createResponseScript(
  destination: string,
  outputMode: "plain" | "openclaw-json",
  _binaryName: string,
): Promise<void> {
  const source =
    outputMode === "openclaw-json"
      ? `#!/bin/sh
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

async function createTarGz(binaryName: string): Promise<Uint8Array> {
  const workDir = await mkdtemp(join(tmpdir(), `clawctl-${binaryName}-`))
  const scriptPath = join(workDir, binaryName)
  const archivePath = join(workDir, `${binaryName}.tar.gz`)
  await createResponseScript(scriptPath, "plain", binaryName)
  await execFileAsync("tar", ["-czf", archivePath, "-C", workDir, binaryName])
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
  await writeFile(join(repoDir, "nanoclaw", "README.md"), "# nanoclaw fixture\n", "utf8")
  await writeFile(join(repoDir, "bitclaw", "README.md"), "# bitclaw fixture\n", "utf8")

  await writeFile(
    fakeNpmPath,
    `#!/bin/sh
if [ "$1" = "view" ] && [ "$2" = "openclaw" ] && [ "$3" = "version" ] && [ "$4" = "--json" ]; then
  echo '"2026.3.7"'
  exit 0
fi

if [ "$1" = "install" ]; then
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

echo "unsupported npm invocation: $*" >&2
exit 1
`,
    "utf8",
  )

  await writeFile(
    fakeUvPath,
    `#!/bin/sh
if [ "$1" = "tool" ] && [ "$2" = "install" ]; then
  tool_dir=""
  spec=""
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tool-dir)
        tool_dir="$2"
        shift 2
        ;;
      *)
        spec="$1"
        shift
        ;;
    esac
  done

  if [ -z "$tool_dir" ] || [ -z "$spec" ]; then
    echo "missing tool dir or spec" >&2
    exit 1
  fi

  mkdir -p "$tool_dir/bin"

  case "$spec" in
    nanobot-ai==*)
      cat > "$tool_dir/bin/nanobot" <<'EOF'
#!/bin/sh
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
      chmod 755 "$tool_dir/bin/nanobot"
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
    *)
      echo "unsupported repo: $repo" >&2
      exit 1
      ;;
  esac

  mkdir -p "$dest"
  cp -R "$source_dir"/. "$dest"/
  exit 0
fi

if [ "$1" = "-C" ] && [ "$3" = "checkout" ]; then
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
  return mkdtemp(join(tmpdir(), "clawctl-root-"))
}

async function runCli(root: string, args: string[]): Promise<string> {
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
    },
  })

  return stdout.trim()
}

async function runCliExpectFailure(root: string, args: string[]): Promise<string> {
  try {
    await runCli(root, args)
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

    if (path === "/pypi/nanobot-ai/json") {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ info: { version: "0.1.4.post4" } }))
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
  await rm(supportRoot, { recursive: true, force: true })
})

describe("tier 1 clawctl cli", () => {
  test("doctor validates the adapter registry", async () => {
    const root = await createTempRoot()
    try {
      const output = await runCli(root, ["doctor"])
      expect(output).toContain("ok: registry: adapter registry is valid")
      expect(output).toContain("doctor: ok")
    } finally {
      await rm(root, { recursive: true, force: true })
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
      expect(statusOutput).toContain("mode: oneshot")
    } finally {
      await rm(root, { recursive: true, force: true })
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
      await rm(root, { recursive: true, force: true })
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
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("tier 2 clawctl cli", () => {
  test.each([
    ["openclaw", "2026.3.7"],
    ["nanobot", "0.1.4.post4"],
  ])("installs latest and chats with %s", async (implementation, version) => {
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

      const installedOutput = await runCli(root, ["list", "--installed"])
      expect(installedOutput).toContain(`${implementation}@${version} *`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("tier 3 clawctl cli", () => {
  test.each([
    ["nanoclaw", "main"],
    ["bitclaw", "main"],
  ])("installs experimental bootstrap target %s", async (implementation, version) => {
    const root = await createTempRoot()
    try {
      const installOutput = await runCli(root, ["install", implementation])
      expect(installOutput).toContain(`installed ${implementation}@${version}`)

      const readmePath = join(root, "installs", "local", implementation, version, "repo", "README.md")
      expect(await readFile(readmePath, "utf8")).toContain(implementation)

      const statusOutput = await runCli(root, ["status", `${implementation}@${version}`])
      expect(statusOutput).toContain("mode: external")
      expect(statusOutput).toContain("chat: no")

      const failureOutput = await runCliExpectFailure(root, ["use", implementation])
      expect(failureOutput).toContain(`implementation cannot be activated yet: ${implementation}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("doctor validates docker-first piclaw metadata", async () => {
    const root = await createTempRoot()
    try {
      const output = await runCli(root, ["doctor", "piclaw"])
      expect(output).toContain("ok: piclaw:docker:tool:")
      expect(output).toContain("doctor: ok")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
