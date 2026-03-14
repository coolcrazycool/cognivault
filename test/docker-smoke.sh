#!/usr/bin/env bash
set -euo pipefail

IMAGE="cognivault:smoke-test"
CONTAINER="cognivault-smoke-$$"

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

echo "Building image..."
docker build -t "$IMAGE" .

echo "Starting container..."
docker run -d --name "$CONTAINER" \
  -e QDRANT_URL=http://host.docker.internal:6333 \
  -e LOG_LEVEL=warn \
  -e COGNIVAULT_DATA_DIR=/data \
  -e EMBEDDING_MODEL=text-embedding-3-small \
  -p 0:3000 \
  "$IMAGE"

# Wait for container to be healthy (up to 60s)
echo "Waiting for healthcheck..."
for i in $(seq 1 12); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    echo "Container healthy after $((i * 5))s"

    # Get the mapped port
    PORT=$(docker port "$CONTAINER" 3000/tcp | head -1 | cut -d: -f2)

    # Hit /health endpoint directly
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
      echo "Health endpoint returned 200"
      echo "SMOKE TEST PASSED"
      exit 0
    else
      echo "Health endpoint returned $HTTP_CODE" >&2
      docker logs "$CONTAINER" >&2
      exit 1
    fi
  fi
  sleep 5
done

echo "Container did not become healthy within 60s" >&2
docker logs "$CONTAINER" >&2
exit 1
