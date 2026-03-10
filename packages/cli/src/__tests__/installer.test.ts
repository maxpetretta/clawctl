import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

import {
  ClawctlInstallerService,
  repairInstallRootReference,
  rewritePythonScriptShebang,
} from "../installer-service.ts"
import { makeInstallerTestLayer, runWithLayer } from "../test-layer.ts"

const tempRoots: string[] = []
const servers: Array<{ stop: () => void }> = []
const originalEnv = {
  CLAWCTL_PYPI_API_ORIGIN: process.env.CLAWCTL_PYPI_API_ORIGIN,
  CLAWCTL_UV_BIN: process.env.CLAWCTL_UV_BIN,
}

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "clawctl-installer-"))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  process.env.CLAWCTL_PYPI_API_ORIGIN = originalEnv.CLAWCTL_PYPI_API_ORIGIN
  process.env.CLAWCTL_UV_BIN = originalEnv.CLAWCTL_UV_BIN
  for (const server of servers.splice(0)) {
    server.stop()
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("installer service", () => {
  test("rewritePythonScriptShebang swaps staged interpreter paths", () => {
    expect(
      rewritePythonScriptShebang(
        "#!/tmp/stage/venv/bin/python\nprint('ok')\n",
        "/tmp/stage/venv/bin",
        "/tmp/install/venv/bin",
      ),
    ).toBe("#!/tmp/install/venv/bin/python\nprint('ok')\n")
  })

  test("repairInstallRootReference rewrites stale partial install references", () => {
    const source =
      "MAPPING={'hermes_cli': '/tmp/installs/local/hermes/main.partial-abc123/repo/hermes_cli'}\n" +
      '#!/tmp/installs/local/hermes/main.partial-abc123/repo/venv/bin/python\n'

    expect(repairInstallRootReference(source, "/tmp/installs/local/hermes/main")).toBe(
      "MAPPING={'hermes_cli': '/tmp/installs/local/hermes/main/repo/hermes_cli'}\n" +
        "#!/tmp/installs/local/hermes/main/repo/venv/bin/python\n",
    )
  })

  test("installImplementation rewrites python entrypoints to the finalized venv", async () => {
    const root = await createRoot()
    const toolsDir = join(root, "tools")
    const uvPath = join(toolsDir, "uv")
    const python3Path = Bun.which("python3") ?? "/usr/bin/python3"
    process.env.CLAWCTL_UV_BIN = uvPath
    await mkdir(toolsDir, { recursive: true })

    await writeFile(
      uvPath,
      `#!/bin/sh
set -eu

if [ "$1" = "venv" ]; then
  venv_root="$2"
  mkdir -p "$venv_root/bin"
  ln -sf "${python3Path}" "$venv_root/bin/python"
  exit 0
fi

if [ "$1" = "pip" ] && [ "$2" = "install" ] && [ "$3" = "--python" ]; then
  venv_python="$4"
  venv_bin="$(dirname "$venv_python")"
  mkdir -p "$venv_bin"
  cat >"$venv_bin/nanobot" <<EOF
#!$venv_python
import sys
print("nanobot-ok")
EOF
  chmod +x "$venv_bin/nanobot"
  exit 0
fi

echo "unexpected uv invocation: $*" >&2
exit 1
`,
      "utf8",
    )
    await chmod(uvPath, 0o755)

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/pypi/nanobot-ai/json") {
          return Response.json({
            info: { version: "0.1.4.post4" },
            releases: { "0.1.4.post4": [] },
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    process.env.CLAWCTL_PYPI_API_ORIGIN = `http://127.0.0.1:${server.port}`

    const record = await runWithLayer(
      Effect.gen(function* () {
        const installer = yield* ClawctlInstallerService
        return yield* installer.installImplementation("nanobot", "local")
      }),
      makeInstallerTestLayer(root),
    )

    const finalPython = join(root, "installs", "local", "nanobot", "0.1.4.post4", "venv", "bin", "python")
    const finalBinEntrypoint = join(root, "installs", "local", "nanobot", "0.1.4.post4", "bin", "nanobot")
    const finalVenvEntrypoint = join(root, "installs", "local", "nanobot", "0.1.4.post4", "venv", "bin", "nanobot")

    expect(record.entrypointCommand).toEqual([finalBinEntrypoint])
    expect(await readFile(finalBinEntrypoint, "utf8")).toContain(`#!${finalPython}`)
    expect(await readFile(finalVenvEntrypoint, "utf8")).toContain(`#!${finalPython}`)

    const child = Bun.spawn([finalBinEntrypoint], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await new Response(child.stdout).text()).toBe("nanobot-ok\n")
    expect(await child.exited).toBe(0)
  })
})
