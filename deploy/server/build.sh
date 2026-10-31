#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINNED_COMMIT="a7a98e0fffed794396b3fbad4dcdbbc184963645"
IMAGE_TAG="ie-llama-cpp-server:b6500-cuda12.4-sm61"
REPO_URL="https://github.com/ggml-org/llama.cpp.git"
SOURCE_FOLDER="$HOME/Work/Code/Personal/inference-engineering-misc/ie-llama-cpp-clone"
LOG_PATH="$SCRIPT_DIR/build.log"
EXPECTED_DOCKERFILE_SHA256="9476a36157c1883ba7bbd2bb8b3ef855cd2bcd4e1965ef02a73524eed782b455"

if [ ! -d "$SOURCE_FOLDER/.git" ]; then
  git clone "$REPO_URL" "$SOURCE_FOLDER"
fi 

git -C "$SOURCE_FOLDER" checkout --quiet "$PINNED_COMMIT"

# Verify source exists before building
ACTUAL_COMMIT="$(git -C "$SOURCE_FOLDER" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$PINNED_COMMIT" ]; then
  echo "ERROR: source is at $ACTUAL_COMMIT, expected $PINNED_COMMIT" >&2
  exit 1
fi

if [ -n "$(git -C "$SOURCE_FOLDER" status --porcelain)" ]; then
  echo "ERROR: source folder has local changes; refusing to build" >&2
  exit 1
fi 

DOCKERFILE="$SOURCE_FOLDER/.devops/cuda.Dockerfile"
ACTUAL_DOCKERFILE_SHA256="$(sha256sum "$DOCKERFILE" | cut -d ' ' -f 1)"
if [ "$ACTUAL_DOCKERFILE_SHA256" != "$EXPECTED_DOCKERFILE_SHA256" ]; then
  echo "ERROR: Dockerfile sha256 is $ACTUAL_DOCKERFILE_SHA256, expected $EXPECTED_DOCKERFILE_SHA256" >&2
  exit 1
fi

# Build the server image, saving the full log
docker build \
  -f "$DOCKERFILE" \
  --target server \
  --build-arg CUDA_VERSION=12.4.0 \
  --build-arg UBUNTU_VERSION=22.04 \
  --build-arg CUDA_DOCKER_ARCH=61 \
  --no-cache \
  --progress=plain \
  -t "$IMAGE_TAG" \
  "$SOURCE_FOLDER" 2>&1 | tee "$LOG_PATH"

# Record the build's identity
IMAGE_ID="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
DEVEL_BASE="nvidia/cuda:12.4.0-devel-ubuntu22.04"
RUNTIME_BASE="nvidia/cuda:12.4.0-runtime-ubuntu22.04"
DEVEL_DIGEST="$(docker image inspect "$DEVEL_BASE" --format '{{index .RepoDigests 0}}')"
RUNTIME_DIGEST="$(docker image inspect "$RUNTIME_BASE" --format '{{index .RepoDigests 0}}')"

cat > "$SCRIPT_DIR/image.json" <<EOF
{
  "image_tag": "$IMAGE_TAG",
  "image_id": "$IMAGE_ID",
  "source_repo": "$REPO_URL",
  "source_commit": "$ACTUAL_COMMIT",
  "dockerfile_sha256": "$ACTUAL_DOCKERFILE_SHA256",
  "build_args": {"CUDA_VERSION": "12.4.0", "UBUNTU_VERSION": "22.04", "CUDA_DOCKER_ARCH": "61"},
  "target": "server",
  "base_images": {"build": "$DEVEL_DIGEST", "runtime": "$RUNTIME_DIGEST"},
  "built_at_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "Built $IMAGE_TAG -> $IMAGE_ID"
