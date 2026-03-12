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
COPY policies/ ./policies/
COPY tests/ ./tests/
COPY test-all.sh ./

RUN mkdir -p /workspace /buffer

ENV REPLAY_BUFFER_DIR=/buffer

# ----- Entrypoint ------------------------------------------------------------
ENTRYPOINT ["pi"]
CMD []
