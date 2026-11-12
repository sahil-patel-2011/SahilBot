#!/bin/zsh
set -e
M="$HOME/Library/Application Support/Foreman/models"
cd "$(dirname "$0")/.."
echo "== cmake"; command -v cmake >/dev/null || brew install cmake
echo "== whisper.cpp"
[ -d vendor/whisper.cpp ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp vendor/whisper.cpp
cd vendor/whisper.cpp
cmake -B build -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF >/dev/null
cmake --build build -j 10 --config Release --target whisper-server whisper-cli 2>&1 | tail -3
ls -la build/bin
cd ../..
echo "== models"
[ -f "$M/ggml-large-v3-turbo-q5_0.bin" ] || curl -L --fail -o "$M/ggml-large-v3-turbo-q5_0.bin" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
[ -f "$M/silero_vad.onnx" ] || curl -L --fail -o "$M/silero_vad.onnx" https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx
ls -la "$M"
echo "== done"
