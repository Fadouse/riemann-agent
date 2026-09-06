#!/usr/bin/env bash
#
# Build Riemann Agent binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     riemann-darwin-arm64.tar.gz
#     riemann-darwin-x64.tar.gz
#     riemann-linux-x64.tar.gz
#     riemann-linux-arm64.tar.gz
#     riemann-windows-x64.zip
#     riemann-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
cd packages/coding-agent

# Clean previous builds
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before Riemann starts (see #7684).
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --external canvas --external zeromq --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/riemann.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --external canvas --external zeromq --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts --outfile "$OUTPUT_DIR/$platform/riemann"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/riemann-prompts"
    cp -r src/riemann/prompts/* "$OUTPUT_DIR/$platform/riemann-prompts/"
    mkdir -p "$OUTPUT_DIR/$platform/riemann-python"
    cp src/riemann/python/requirements.lock src/riemann/python/prelude.py "$OUTPUT_DIR/$platform/riemann-python/"

    # The kernel loads ZeroMQ only after IPython starts; keep the N-API module external
    # so --help/--version work in Bun and copy its complete POSIX platform package.
    if [[ "$platform" != windows-* ]]; then
        mkdir -p "$OUTPUT_DIR/$platform/node_modules"
        cp -r ../../node_modules/zeromq "$OUTPUT_DIR/$platform/node_modules/"
    fi

    # Copy the selected architecture's native platform helpers next to the executable.
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform" "$OUTPUT_DIR/$platform/$native_path/"
done

# Create archives
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating riemann-$platform.zip..."
        (cd "$platform" && zip -r ../riemann-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating riemann-$platform.tar.gz..."
        mv "$platform" riemann && tar -czf riemann-$platform.tar.gz riemann && mv riemann "$platform"
    fi
done

# Extract archives for easy local testing
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../riemann-$platform.zip)
    else
        tar -xzf riemann-$platform.tar.gz && mv riemann "$platform"
    fi
    node "$REPO_ROOT/scripts/check-riemann-binary-release.mjs" "$OUTPUT_DIR/$platform" "$platform"
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/riemann.exe"
    else
        echo "  $OUTPUT_DIR/$platform/riemann"
    fi
done
