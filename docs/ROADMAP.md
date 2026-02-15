# Implementation Roadmap

## Phase 1: Rust + UniFFI Foundation
- Build `rust/` core for iOS arm64 and Android arm64-v8a.
- Expose `hash_frame_bytes(bytes)` through UniFFI.
- Add native smoke tests calling Rust from Swift/Kotlin.

Exit Criteria:
- Native modules can call Rust hasher in both platforms.

## Phase 2: Hardware Signer
- iOS: generate Secure Enclave P-256 key (`kSecAttrTokenIDSecureEnclave`).
- Android: generate Keystore key with `setIsStrongBoxBacked(true)` when available.
- Expose `signDigest(hash)` to RN bridge.
- Return trust-level metadata with each signature operation.

Current status:
- Native modules now expose `ensureHardwareKey` and `signPayload` with hardware-backed key provisioning.
- Trust level resolution is implemented (`secure_enclave`/`strongbox`/`tee`/`software_fallback`).
- Integrity checks are still baseline placeholders and must be hardened before production.

Exit Criteria:
- Non-exportable key creation verified on real hardware.

## Phase 3: Atomic Capture Integration
- Integrate VisionCamera frame processor path.
- Capture frame bytes in native layer and avoid pre-sign file writes.
- Pipe frame bytes to Rust hash function and native signer.

Current status:
- `AttestedCamera` now captures from `react-native-vision-camera` and passes `sourcePhotoPath` to native.
- Native placeholder pipelines derive `sourceSha256` from capture bytes, sign hash-bound payloads, and emit signed artifacts.
- JS layer performs a source-hash sanity check against native metadata before `onCapture`.
- Native capture now fails closed when `sourcePhotoPath` is missing/empty (no dummy-image fallback path).
- No extra copy file is written during native signing; output path references the captured source photo.
- Frame-processor interception and in-memory raw-buffer hashing are still pending.

Exit Criteria:
- End-to-end signed capture works without temporary unsigned file.

## Phase 4: C2PA Manifest Compliance
- Use `c2pa-rs` builder APIs to inject JUMBF claim + assertion set.
- Validate resulting JPEG with `c2patool` and verify.contentauthenticity.org.

Current status:
- Rust core exposes `build_c2pa_placeholder(...)` returning manifest JSON sidecar data.
- Real JUMBF embedding with `c2pa-rs` is still pending.

Exit Criteria:
- Output file validates in independent C2PA verifiers.

## Decisions for Open Questions
- Buffer format / zero-copy:
  - Short-term: perform one explicit copy into Rust-owned buffer for safety.
  - Mid-term: optimize with FFI pointer + length only after correctness baseline.
- Binary size:
  - Start with image-only features in Rust crate graph.
  - Use LTO, strip symbols, and disable default features where possible.
- Minimum OS:
  - iOS 14+ and Android 9+ baseline.
  - Recommend Android 11+ for higher StrongBox availability.
