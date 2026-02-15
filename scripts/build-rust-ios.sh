#!/usr/bin/env bash
#
# build-rust-ios.sh — Compile the Rust static library for iOS.
# Invoked automatically by the podspec script_phase during Xcode builds.
#
set -euo pipefail

# Xcode doesn't inherit the user's shell PATH, so source cargo env if present.
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi

if ! command -v cargo &>/dev/null; then
  echo "error: cargo not found. Install Rust: https://rustup.rs" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
# When run from the podspec, PODS_TARGET_SRCROOT points to the package root.
# Allow overriding for manual runs.
SRCROOT="${PODS_TARGET_SRCROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
MANIFEST="$SRCROOT/rust/Cargo.toml"

if [ ! -f "$MANIFEST" ]; then
  echo "error: Cargo.toml not found at $MANIFEST" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Determine cargo profile
# ---------------------------------------------------------------------------
CONFIGURATION="${CONFIGURATION:-Debug}"
if [ "$CONFIGURATION" = "Release" ]; then
  PROFILE="release"
  PROFILE_FLAG="--release"
else
  PROFILE="debug"
  PROFILE_FLAG=""
fi

# ---------------------------------------------------------------------------
# Map Xcode PLATFORM_NAME + ARCHS → Rust targets
# ---------------------------------------------------------------------------
PLATFORM_NAME="${PLATFORM_NAME:-iphoneos}"
ARCHS="${ARCHS:-arm64}"

RUST_TARGETS=()
for arch in $ARCHS; do
  case "${PLATFORM_NAME}-${arch}" in
    iphoneos-arm64)         RUST_TARGETS+=("aarch64-apple-ios") ;;
    iphonesimulator-arm64)  RUST_TARGETS+=("aarch64-apple-ios-sim") ;;
    iphonesimulator-x86_64) RUST_TARGETS+=("x86_64-apple-ios") ;;
    *)
      echo "warning: unsupported platform/arch combo: ${PLATFORM_NAME}-${arch}" >&2
      ;;
  esac
done

if [ ${#RUST_TARGETS[@]} -eq 0 ]; then
  echo "error: no valid Rust targets for PLATFORM_NAME=$PLATFORM_NAME ARCHS=$ARCHS" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Ensure required targets are installed
# ---------------------------------------------------------------------------
for target in "${RUST_TARGETS[@]}"; do
  if ! rustup target list --installed | grep -q "^${target}$"; then
    echo "Installing Rust target: $target"
    rustup target add "$target"
  fi
done

# ---------------------------------------------------------------------------
# Build each target
# ---------------------------------------------------------------------------
LIB_NAME="libattestation_mobile_core.a"
BUILT_LIBS=()

for target in "${RUST_TARGETS[@]}"; do
  echo "Building Rust for $target ($PROFILE)..."
  cargo build --manifest-path "$MANIFEST" --target "$target" $PROFILE_FLAG
  BUILT_LIBS+=("$SRCROOT/rust/target/$target/$PROFILE/$LIB_NAME")
done

# ---------------------------------------------------------------------------
# Produce a universal binary via lipo
# ---------------------------------------------------------------------------
OUTPUT_DIR="$SRCROOT/rust/target/universal-ios/$PROFILE"
mkdir -p "$OUTPUT_DIR"

if [ ${#BUILT_LIBS[@]} -eq 1 ]; then
  cp "${BUILT_LIBS[0]}" "$OUTPUT_DIR/$LIB_NAME"
else
  lipo -create "${BUILT_LIBS[@]}" -output "$OUTPUT_DIR/$LIB_NAME"
fi

echo "Rust iOS build complete: $OUTPUT_DIR/$LIB_NAME"
