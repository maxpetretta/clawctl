FROM python:3.11-slim

ARG CLAW_VERSION

RUN python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir "nanobot-ai==${CLAW_VERSION}"

ENTRYPOINT ["nanobot"]
