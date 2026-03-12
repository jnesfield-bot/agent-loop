#!/bin/bash
set -e

IMAGE_NAME="${IMAGE_NAME:-rho}"

echo "Building $IMAGE_NAME..."
docker build -t "$IMAGE_NAME" .

echo ""
echo "Running $IMAGE_NAME (interactive pi session with agent-loop)..."
echo ""
echo "  Commands available:"
echo "    /loop <task>     — Run task through heartbeat loop"
echo "    /loop-status     — Show loop state"
echo "    /loop-stop       — Stop running loop"
echo "    /loop-memory     — Show agent memory"
echo "    /loop-config     — Configure max heartbeats"
echo ""
echo "  For headless mode:"
echo "    docker run -e ANTHROPIC_API_KEY=... $IMAGE_NAME npx tsx src/main.ts /workspace"
echo ""

docker run -it \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v "${PWD}/workspace:/workspace" \
  -v "${PWD}/buffer:/buffer" \
  "$IMAGE_NAME" "$@"
