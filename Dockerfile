FROM node:22-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install pi globally
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY skills/ ./skills/
COPY sequences/ ./sequences/

RUN mkdir -p /workspace /buffer

ENV REPLAY_BUFFER_DIR=/buffer

# Interactive pi session with agent-loop extension loaded.
# This opens the same TUI you get when running pi normally,
# but with /loop, /loop-status, /loop-stop, /loop-memory commands
# and the heartbeat tool available.
#
# Override for headless mode:
#   docker run ... agent-loop npx tsx src/main.ts /workspace
ENTRYPOINT ["pi", "--dir", "/workspace", "-e", "/app/src/extension.ts"]
