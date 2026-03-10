FROM debian:bookworm-slim

ARG CLAW_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/sipeed/picoclaw/releases/download/${CLAW_VERSION}/picoclaw_Linux_arm64.tar.gz" \
    -o /tmp/picoclaw.tar.gz \
  && tar -xzf /tmp/picoclaw.tar.gz -C /usr/local/bin picoclaw \
  && chmod +x /usr/local/bin/picoclaw \
  && rm -f /tmp/picoclaw.tar.gz

ENTRYPOINT ["picoclaw"]
