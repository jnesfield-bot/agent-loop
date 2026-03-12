#!/usr/bin/env bash
set -e

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "Error: ANTHROPIC_API_KEY is not set"
  echo ""
  echo "Usage:"
  echo "  ANTHROPIC_API_KEY=sk-ant-... ./run.sh"
  exit 1
fi

echo "Building agent-loop container..."
docker build -t agent-loop .

echo ""
echo "Starting pi with agent-loop extension..."
echo "Commands:"
echo "  /loop <task>       — Run a task through the heartbeat loop"
echo "  /loop-status       — Show loop state"
echo "  /loop-stop         — Stop a running loop"
echo "  /loop-memory       — Show agent memory"
echo "  /loop-config       — Configure loop settings"
echo ""

docker run -it --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)/workspace:/workspace" \
  -w /workspace \
  agent-loop
