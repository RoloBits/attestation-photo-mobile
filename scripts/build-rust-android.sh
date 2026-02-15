#!/usr/bin/env bash
#
# build-rust-android.sh — Compile the Rust shared library for Android.
# Invoked automatically by the Gradle buildRustAndroid task.
#
# Usage: build-rust-android.sh <rust-dir> <jniLibs-output-dir> <debug|release>
#
set -euo pipefail

# Source cargo env (Gradle may not inherit shell PATH).
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck source=/dev/null
  . "$HOME/.cargo/env"
fi

if ! command -v cargo &>/dev/null; then
  echo "error: cargo not found. Install Rust: https://rustup.rs" >&2
  exit 1
fi

if ! command -v cargo-ndk &>/dev/null && ! cargo ndk --version &>/dev/null 2>&1; then
  echo "error: cargo-ndk not found. Install it: cargo install cargo-ndk" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
if [ $# -lt 3 ]; then
  echo "usage: $0 <rust-dir> <jniLibs-output-dir> <debug|release>" >&2
  exit 1
fi

RUST_DIR="$1"
JNILIBS_DIR="$2"
BUILD_TYPE="$3"

MANIFEST="$RUST_DIR/Cargo.toml"
if [ ! -f "$MANIFEST" ]; then
  echo "error: Cargo.toml not found at $MANIFEST" >&2
  exit 1
fi

if [ "$BUILD_TYPE" = "release" ]; then
  PROFILE_FLAG="--release"
else
  PROFILE_FLAG=""
fi

# ---------------------------------------------------------------------------
# Ensure required target is installed
# ---------------------------------------------------------------------------
TARGET="aarch64-linux-android"
if ! rustup target list --installed | grep -q "^${TARGET}$"; then
  echo "Installing Rust target: $TARGET"
  rustup target add "$TARGET"
fi

# ---------------------------------------------------------------------------
# Build with cargo-ndk (must cd into Rust dir; cargo-ndk runs cargo metadata
# in CWD before processing --manifest-path)
# ---------------------------------------------------------------------------
echo "Building Rust for Android ($BUILD_TYPE)..."
cd "$RUST_DIR"
cargo ndk -t arm64-v8a -o "$JNILIBS_DIR" build $PROFILE_FLAG

echo "Rust Android build complete: $JNILIBS_DIR"

# ---------------------------------------------------------------------------
# Generate UniFFI Kotlin bindings (uses host-built library)
# ---------------------------------------------------------------------------
KOTLIN_OUT_DIR="$(dirname "$RUST_DIR")/native/android/src/main/java"
echo "Generating UniFFI Kotlin bindings..."

# Build host library for bindgen (if not already built)
cargo build $PROFILE_FLAG 2>/dev/null

if [ "$BUILD_TYPE" = "release" ]; then
  HOST_LIB_DIR="$RUST_DIR/target/release"
else
  HOST_LIB_DIR="$RUST_DIR/target/debug"
fi

# Detect host library extension
if [ -f "$HOST_LIB_DIR/libattestation_mobile_core.dylib" ]; then
  HOST_LIB="$HOST_LIB_DIR/libattestation_mobile_core.dylib"
elif [ -f "$HOST_LIB_DIR/libattestation_mobile_core.so" ]; then
  HOST_LIB="$HOST_LIB_DIR/libattestation_mobile_core.so"
else
  echo "warning: Host library not found, skipping Kotlin bindgen" >&2
  exit 0
fi

cargo run --bin uniffi-bindgen generate --library "$HOST_LIB" --language kotlin --out-dir "$KOTLIN_OUT_DIR"
echo "UniFFI Kotlin bindings generated: $KOTLIN_OUT_DIR"
