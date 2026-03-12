#!/bin/bash
set -e

IMAGE_NAME="${IMAGE_NAME:-agent-loop}"

echo "Building $IMAGE_NAME..."
docker build -t "$IMAGE_NAME" .

echo ""
echo "Running $IMAGE_NAME..."
echo "  - Workspace mounted at /workspace"
echo "  - Replay buffer at /buffer"
echo ""

# Default: autonomous heartbeat mode
# Add -- pi -e /app/src/extension.ts for interactive TUI mode
docker run -it \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  -v "${PWD}/workspace:/workspace" \
  -v "${PWD}/buffer:/buffer" \
  "$IMAGE_NAME" "$@"
