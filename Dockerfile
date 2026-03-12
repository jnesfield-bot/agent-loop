FROM node:22-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install pi globally
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN mkdir -p /workspace

# Run pi interactively with our extension loaded
ENTRYPOINT ["pi", "-e", "/app/src/extension.ts"]
