# Generic Codex worker; never embeds credentials, policies, or evaluation tasks.
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}
ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" \
 && apt-get update \
 && apt-get install -y --no-install-recommends git python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "@openai/codex@$CODEX_VERSION" \
 && npm cache clean --force
WORKDIR /workspace
