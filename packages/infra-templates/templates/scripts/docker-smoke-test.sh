#!/usr/bin/env bash
# Runtime smoke test for a built Docker image.
#
# Starts the container with stubbed env vars and waits up to 120 seconds
# for the ready log line ({{READY_LOG_PATTERN}}). If the container
# crashes or times out, prints the full logs and exits non-zero.
#
# Why this exists:
#   Cloud Run container start failures (phantom named-export, missing COPY)
#   are only detected after image push + Cloud Run health check timeout —
#   5+ minutes per attempt. Running the image locally in CI, right after
#   build, surfaces the same class of bug in ~30 seconds and prevents the
#   broken image from ever reaching Cloud Run.
#
# This catches a superset of what check-named-exports.sh does because it
# uses the actual container runtime (not local Bun on the host filesystem).
# E.g., a Dockerfile COPY gap only manifests inside the container image.
#
# Placeholders:
#   {{READY_LOG_PATTERN}} — サーバー起動完了時に出るログ行の grep パターン
#                           例: "server running on port"
#   下の docker run の -e 行 — サーバーの必須 env（Zod 等の起動時バリデーション）
#                           を満たすスタブ値に置き換える。実クレデンシャル禁止。
#
# Usage: bash scripts/docker-smoke-test.sh <IMAGE>
# Exit codes: 0 = container started; 1 = crash or timeout.

set -e

IMAGE="${1:-}"
if [ -z "$IMAGE" ]; then
  echo "❌ Usage: $0 <IMAGE>"
  exit 1
fi

CONTAINER_NAME="smoke-$$"
MAX_WAIT_SECONDS=120
POLL_INTERVAL=3

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "🔍 Smoke test: starting container from $IMAGE..."

# Stubbed env: satisfies the server's startup config validation.
# Add one -e line per required env var, with an obviously-fake stub value.
docker run -d --name "$CONTAINER_NAME" \
  -p 18080:8080 \
  -e APP_URL=http://localhost:18080 \
  -e NODE_ENV=test \
  -e "{{STUB_ENV_1}}" \
  -e "{{STUB_ENV_2}}" \
  "$IMAGE" >/dev/null

iterations=$((MAX_WAIT_SECONDS / POLL_INTERVAL))
for i in $(seq 1 $iterations); do
  sleep $POLL_INTERVAL

  # Container still running?
  running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "false")
  if [ "$running" != "true" ]; then
    exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo "?")
    echo "❌ Container crashed (exit code $exit_code) before listening on port."
    echo ""
    echo "--- container logs ---"
    docker logs "$CONTAINER_NAME" 2>&1 | tail -40
    echo "----------------------"
    exit 1
  fi

  # Server ready log?
  if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "{{READY_LOG_PATTERN}}"; then
    elapsed=$((i * POLL_INTERVAL))
    echo "✅ Container started in ~${elapsed}s — import graph and Dockerfile COPY are valid."
    exit 0
  fi
done

echo "❌ Container did not start within ${MAX_WAIT_SECONDS}s."
echo ""
echo "--- container logs ---"
docker logs "$CONTAINER_NAME" 2>&1 | tail -40
echo "----------------------"
exit 1
