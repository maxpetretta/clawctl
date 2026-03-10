FROM debian:bookworm-slim

ARG CLAW_VERSION

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/zeroclaw-labs/zeroclaw/releases/download/${CLAW_VERSION}/zeroclaw-aarch64-unknown-linux-gnu.tar.gz" \
    -o /tmp/zeroclaw.tar.gz \
  && tar -xzf /tmp/zeroclaw.tar.gz -C /usr/local/bin zeroclaw \
  && chmod +x /usr/local/bin/zeroclaw \
  && rm -f /tmp/zeroclaw.tar.gz

ENTRYPOINT ["zeroclaw"]
