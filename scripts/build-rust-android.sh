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
# Build with cargo-ndk
# ---------------------------------------------------------------------------
echo "Building Rust for Android ($BUILD_TYPE)..."
cargo ndk -t arm64-v8a -o "$JNILIBS_DIR" build --manifest-path "$MANIFEST" $PROFILE_FLAG

echo "Rust Android build complete: $JNILIBS_DIR"
