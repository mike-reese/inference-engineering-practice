#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_TAG="ie-tensorrt-llm:1.2.1-nvml-byref"
BASE_IMAGE="nvcr.io/nvidia/tensorrt-llm/release:1.2.1@sha256:33cd085b772947bd22b7273886539331420404e5d2a4a039945241945ff927b9"
PATCHED_FILE="/usr/local/lib/python3.12/dist-packages/tensorrt_llm/_utils.py"
LOG_PATH="$SCRIPT_DIR/build.log"


# Build the server image, saving the full log
docker build \
  --no-cache \
  --progress=plain \
  -t "$IMAGE_TAG" \
  "$SCRIPT_DIR" 2>&1 | tee "$LOG_PATH"


# Record the build's identity, read back from the built image
IMAGE_ID="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
DOCKERFILE_SHA256="$(sha256sum "$SCRIPT_DIR/Dockerfile" | cut -d ' ' -f 1)"
PATCHED_SHA256="$(docker run --rm --entrypoint sha256sum "$IMAGE_TAG" "$PATCHED_FILE" | cut -d ' ' -f 1)"
ENGINE_VERSION="$(docker run --rm --entrypoint python3 "$IMAGE_TAG" -c \
  'import importlib.metadata as m; print(m.version("tensorrt_llm"))')"

cat > "$SCRIPT_DIR/image.json" <<JSON
{
  "image_tag": "$IMAGE_TAG",
  "image_id": "$IMAGE_ID",
  "base_image": "$BASE_IMAGE",
  "dockerfile_sha256": "$DOCKERFILE_SHA256",
  "engine_version": "$ENGINE_VERSION",
  "local_patch": {
    "file": "$PATCHED_FILE",
    "sha256_after": "$PATCHED_SHA256",
    "source": "https://github.com/NVIDIA/TensorRT-LLM/issues/18816"
  },
  "built_at_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "Built $IMAGE_TAG -> $IMAGE_ID"
