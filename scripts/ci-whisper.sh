#!/bin/zsh
# Builds the whisper-server binary the app bundles (extraResources: vendor/whisper.cpp/build/bin), with
# the same CMake flags as scripts/voice-setup.sh, for the release workflow. Only the server target is
# built and no voice models are downloaded (the app fetches those on first use).
#   WHISPER_REF=<commit or tag> scripts/ci-whisper.sh
# MACOSX_DEPLOYMENT_TARGET matches the app's minimumSystemVersion (13.0) so the binary runs on Ventura.
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${WHISPER_REF:-master}"
DIR=vendor/whisper.cpp

command -v cmake >/dev/null || brew install cmake
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$DIR"
  git -C "$DIR" init -q
  git -C "$DIR" remote add origin https://github.com/ggml-org/whisper.cpp
fi
# A pinned commit or tag, shallow (GitHub serves single commits by SHA).
git -C "$DIR" fetch -q --depth 1 origin "$REF"
git -C "$DIR" checkout -q --force FETCH_HEAD
echo "whisper.cpp at $(git -C "$DIR" rev-parse HEAD)"

cd "$DIR"
export MACOSX_DEPLOYMENT_TARGET=13.0
cmake -B build -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DCMAKE_OSX_ARCHITECTURES=arm64 >/dev/null
cmake --build build -j "$(sysctl -n hw.ncpu)" --config Release --target whisper-server 2>&1 | tail -3
test -x build/bin/whisper-server
ls -la build/bin
