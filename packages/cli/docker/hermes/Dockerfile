FROM python:3.11-slim

ARG CLAW_VERSION=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git nodejs npm \
  && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/hermes/venv

ENV PATH="/opt/hermes/venv/bin:${PATH}"

RUN git clone --depth 1 --branch "${CLAW_VERSION}" https://github.com/NousResearch/hermes-agent.git /opt/hermes/repo \
  && git -C /opt/hermes/repo submodule update --init --recursive \
  && pip install --no-cache-dir --upgrade pip setuptools wheel \
  && (cd /opt/hermes/repo && pip install --no-cache-dir -e '.[all]' || pip install --no-cache-dir -e .) \
  && if [ -f /opt/hermes/repo/mini-swe-agent/pyproject.toml ]; then pip install --no-cache-dir -e /opt/hermes/repo/mini-swe-agent || true; fi \
  && if [ -f /opt/hermes/repo/tinker-atropos/pyproject.toml ]; then pip install --no-cache-dir -e /opt/hermes/repo/tinker-atropos || true; fi \
  && if [ -f /opt/hermes/repo/package.json ]; then (cd /opt/hermes/repo && npm install --silent || true); fi

RUN cat <<'EOF' >/opt/hermes/clawctl-hermes-chat.py
from pathlib import Path
import sys

project_root = Path("/opt/hermes/repo")
sys.path.insert(0, str(project_root))

from cli import HermesCLI


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: clawctl-hermes-chat.py <message>", file=sys.stderr)
        return 1

    cli = HermesCLI(compact=True, verbose=False)
    if not cli._init_agent():
        return 1

    response = cli.agent.chat(sys.argv[1])
    if not response:
        return 1

    print(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
EOF

RUN cat <<'EOF' >/usr/local/bin/hermes
#!/bin/sh
exec /opt/hermes/venv/bin/python -m hermes_cli.main "$@"
EOF

RUN chmod +x /opt/hermes/clawctl-hermes-chat.py /usr/local/bin/hermes

ENTRYPOINT ["hermes"]
