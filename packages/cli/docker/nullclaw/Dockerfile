FROM debian:bookworm-slim

ARG CLAW_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/nullclaw/nullclaw/releases/download/${CLAW_VERSION}/nullclaw-linux-aarch64.bin" \
    -o /usr/local/bin/nullclaw \
  && chmod +x /usr/local/bin/nullclaw

ENTRYPOINT ["nullclaw"]
