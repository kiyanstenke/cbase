#!/bin/bash
# Builds the per-user backend image (cbase-backend) and the project container image (cbase-projectbox) from the same multi-stage
# Dockerfile. Stages a lean build context (only electron/ + entries + wrapper + cbase-project + cbase-git + cbase-clone +
# cbase-manifest + cbase-lfs-access + package.json + package-lock.json) so that node_modules and the tests do not travel to the
# Docker daemon.
#
# The backend is the LAST stage and is therefore built without --target; the project box with --target projectbox (the stage
# `base` then comes from the cache). The project box gets NO :latest here — the host has none; the deploy builds
# `cbase-projectbox:cand-<release>`, checks it and only then distributes it into the user containers.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${CBASE_IMAGE:-cbase-backend}"
PROJECTBOX="${CBASE_PROJECTBOX_IMAGE:-cbase-projectbox}:${CBASE_PROJECTBOX_TAG:-hand}"
CTX="build-context"

rm -rf "$CTX"
mkdir -p "$CTX"
cp -R electron "$CTX/electron"
find "$CTX" -name ".DS_Store" -delete
cp headless.js package.json package-lock.json entry.sh cbase-project cbase-git cbase-clone projectbox-entry.sh cbase-wrapper "$CTX/"
cp cbase-manifest "$CTX/"   # the manifest program of the relocation (backend only, /usr/local/bin)
cp cbase-lfs-access "$CTX/"   # the LFS helper of the agent shells (backend only, /usr/local/bin)

docker build -t "$IMAGE" -f Dockerfile "$CTX"
echo "OK: image '$IMAGE' built."
docker build --target projectbox -t "$PROJECTBOX" -f Dockerfile "$CTX"
echo "OK: image '$PROJECTBOX' built."
