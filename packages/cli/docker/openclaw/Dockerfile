FROM node:20-bookworm-slim

ARG CLAW_VERSION

RUN npm install --global "openclaw@${CLAW_VERSION}"

ENTRYPOINT ["openclaw"]
