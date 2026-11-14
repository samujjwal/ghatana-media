#!/usr/bin/env bash
# Builds a single static whisper-cli with the ggml Vulkan backend (GPU) for the local speech-to-text lane.
#
# Static linking matters: the manifest pins the SHA-256 of whisper-cli, so all whisper/ggml code must live inside
# that one file. A shared build would load libwhisper/libggml-*.so from beside it, unverified. Only system
# libraries (libvulkan loader, libc/libstdc++/libgomp) remain dynamic.
#
# Build-time inputs (not redistributed, recorded in THIRD_PARTY_NOTICES.md):
#   KhronosGroup/Vulkan-Headers v1.4.341        (Apache-2.0 OR MIT)
#   KhronosGroup/SPIRV-Headers  vulkan-sdk-1.4.341.0 (MIT-style Khronos licence)
#   glslc shader compiler (any; the Android NDK shader-tools copy works)
# The NVIDIA driver's Vulkan ICD and /usr/lib/x86_64-linux-gnu/libvulkan.so.1 must already be installed.
# After building, re-run install-local-manifests.sh: the binary digest is enforced.
set -euo pipefail
ROOT="${MEDIA_LOCAL_MODEL_ROOT:-$HOME/.local/share/ghatana-media}"
RT="$ROOT/runtimes"
SRC="$RT/whisper.cpp-src"
HDR="$RT/vulkan-headers-src"
PFX="$RT/vulkan-prefix"
GLSLC="${GLSLC:-$(command -v glslc || true)}"
[ -x "$GLSLC" ] || { echo "glslc not found; set GLSLC=/path/to/glslc" >&2; exit 2; }
[ -d "$SRC" ] || { echo "whisper.cpp source missing at $SRC" >&2; exit 2; }
mkdir -p "$HDR"
[ -d "$HDR/Vulkan-Headers" ] || git clone -q --depth 1 --branch v1.4.341 https://github.com/KhronosGroup/Vulkan-Headers.git "$HDR/Vulkan-Headers"
[ -d "$HDR/SPIRV-Headers" ] || git clone -q --depth 1 --branch vulkan-sdk-1.4.341.0 https://github.com/KhronosGroup/SPIRV-Headers.git "$HDR/SPIRV-Headers"
[ "$(git -C "$HDR/Vulkan-Headers" rev-parse HEAD)" = b5c8f996196ba4aa6d8f97e52b5d3b6e70f7e4e2 ] || { echo "Vulkan-Headers revision mismatch" >&2; exit 3; }
[ "$(git -C "$HDR/SPIRV-Headers" rev-parse HEAD)" = 04f10f650d514df88b76d25e83db360142c7b174 ] || { echo "SPIRV-Headers revision mismatch" >&2; exit 3; }
for r in Vulkan-Headers SPIRV-Headers; do
  cmake -S "$HDR/$r" -B "$HDR/$r/build" -DCMAKE_INSTALL_PREFIX="$PFX" >/dev/null
  cmake --install "$HDR/$r/build" >/dev/null
done
mkdir -p "$PFX/lib"
ln -sf /usr/lib/x86_64-linux-gnu/libvulkan.so.1 "$PFX/lib/libvulkan.so"
rm -rf "$SRC/build-vulkan"
cmake -S "$SRC" -B "$SRC/build-vulkan" -DGGML_VULKAN=ON -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$PFX" -DVulkan_INCLUDE_DIR="$PFX/include" -DVulkan_LIBRARY="$PFX/lib/libvulkan.so" \
  -DVulkan_GLSLC_EXECUTABLE="$GLSLC" -DWHISPER_BUILD_TESTS=OFF >/dev/null
cmake --build "$SRC/build-vulkan" -j "$(nproc)" --target whisper-cli >/dev/null
if ldd "$SRC/build-vulkan/bin/whisper-cli" | grep -qE 'libwhisper|libggml'; then
  echo "whisper-cli is not self-contained (loads libwhisper/libggml); refusing" >&2; exit 4
fi
echo "built $SRC/build-vulkan/bin/whisper-cli"
