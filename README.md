<p align="center">
     <h1 align="center">@rolobits/attestation-photo-mobile</h1>
     <p align="center">
       Hardware-attested photo capture for React Native with embedded C2PA manifests.
     </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rolobits/attestation-photo-mobile"><img src="https://img.shields.io/npm/v/@rolobits/attestation-photo-mobile?style=flat-square&color=blue" alt="npm"></a>
  <img src="https://img.shields.io/badge/types-TypeScript-blue?style=flat-square" alt="TypeScript">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/@rolobits/attestation-photo-mobile?style=flat-square" alt="license"></a>
</p>

<br>

Every photo taken through this SDK is signed by the device's tamper-resistant hardware (Secure Enclave on iOS, StrongBox/TEE on Android) and embedded with a [C2PA](https://c2pa.org/) manifest before the file is ever written to disk. The resulting JPEG is independently verifiable with any standard C2PA tool.

## Install

### 1. npm

```bash
npm install @rolobits/attestation-photo-mobile
```

| Peer dependency | Version |
|---|---|
| `react` | >= 18 |
| `react-native` | >= 0.73 |

### 2. Rust toolchain (one-time setup)

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add mobile targets
rustup target add aarch64-apple-ios        # iOS device
rustup target add aarch64-apple-ios-sim    # iOS simulator (Apple Silicon)
rustup target add aarch64-linux-android    # Android

# Android builds require cargo-ndk
cargo install cargo-ndk
```

### 3. iOS

The Rust static library is compiled automatically via a CocoaPods script phase. No manual Xcode linking required.

```bash
cd ios && pod install
```

### 4. Android

The Rust shared library is compiled automatically via a Gradle task. Just build your app as usual.

### 5. Permissions

| Permission | iOS (`Info.plist`) | Android (`AndroidManifest.xml`) | Required? |
|---|---|---|---|
| Camera | `NSCameraUsageDescription` | `android.permission.CAMERA` | Yes |
| Location | `NSLocationWhenInUseUsageDescription` | `android.permission.ACCESS_FINE_LOCATION` | Only with `includeLocation: true` |

## Quick start

This library is headless — it handles attestation and signing only. You bring your own camera (e.g. `react-native-vision-camera`, `expo-camera`, or any source that produces a JPEG path). See the [example app](./example/) for a full camera UI implementation.

```tsx
import {
  ensureHardwareKey,
  getAttestationStatus,
  captureAndSignAtomic,
  saveToGallery,
} from "@rolobits/attestation-photo-mobile";

// 1. Provision the hardware key (call once, idempotent)
await ensureHardwareKey();

// 2. Check device integrity
const status = await getAttestationStatus();
if (status.isCompromised) throw new Error("Device compromised");

// 3. Take a photo with any camera library
const rawPhoto = await camera.current.takePhoto();

// 4. Sign and embed the C2PA manifest into the JPEG
const signed = await captureAndSignAtomic({
  sourcePhotoPath: rawPhoto.path,
  includeLocation: true,               // embed GPS in the manifest
  nonce: "server-challenge-token",      // replay prevention
  appName: "My App",
});
// signed.path           → JPEG with embedded C2PA manifest
// signed.trustLevel     → "secure_enclave" | "strongbox" | "tee"
// signed.embeddedManifest → true

// 5. Optionally save to the device gallery
await saveToGallery({ filePath: signed.path });
```

### Available functions

| Function | Returns | Description |
|---|---|---|
| `getAttestationStatus()` | `Promise<AttestationStatus>` | Check device integrity and hardware trust level. |
| `ensureHardwareKey()` | `Promise<{ trustLevel }>` | Provision the hardware-backed signing key. Idempotent. |
| `captureAndSignAtomic(params)` | `Promise<SignedPhoto>` | Hash, sign, and embed a C2PA manifest into a JPEG. |
| `saveToGallery(params)` | `Promise<{ uri }>` | Save a file to the device photo gallery. |
| `hashPhotoAtPath(params)` | `Promise<{ sha256Hex }>` | Compute the SHA-256 hash of a photo file. |
| `signPayload(params)` | `Promise<{ signatureBase64, trustLevel }>` | Sign arbitrary base64 data with the hardware key. |

## How it works

```
User presses capture
  |
  v
[1] Your app takes a photo
  |
  v
[2] Native module reads JPEG bytes into memory
  |
  v
[3] Native creates a HardwareSigner (callback object)
  |
  v
[4] Native calls Rust: build_and_sign_c2pa(jpeg_bytes, context, signer)
  |   |
  |   +---> Rust hashes the raw JPEG (SHA-256)
  |   +---> Rust builds a C2PA manifest with claims
  |   +---> Rust calls signer.sign(data)
  |   |       |
  |   |       +---> Crosses FFI back into Swift/Kotlin
  |   |       +---> Hardware signs with Secure Enclave / StrongBox
  |   |       +---> Returns signature bytes to Rust
  |   |
  |   +---> Rust embeds the signed manifest into JPEG as JUMBF
  |   +---> Returns final JPEG bytes
  |
  v
[5] Native writes signed JPEG to disk (atomic write)
  |
  v
[6] SignedPhoto returned to JavaScript
```

The entire pipeline is a single native call. No unsigned file is written to disk. The private key never crosses the FFI boundary. Rust calls back into native code for every signature operation.

## SignedPhoto

The object returned by `captureAndSignAtomic()`:

```ts
interface SignedPhoto {
  path: string;                    // File path to the signed JPEG
  signature: string;               // SHA-256 hex of the original asset
  algorithm: "ECDSA_P256_SHA256";  // Signing algorithm used
  manifestFormat: "c2pa-jumbf";    // Always JUMBF
  trustLevel: PlatformTrustLevel;  // "secure_enclave" | "strongbox" | "tee" | "software_fallback"
  embeddedManifest?: boolean;      // true when real C2PA manifest is embedded
  metadata: CaptureMetadata;       // Device model, OS, timestamp, nonce, etc.
}
```

## C2PA manifest contents

Each signed JPEG contains these assertions:

| Assertion | Label | Content |
|---|---|---|
| Created action | `c2pa.actions` | `action: "c2pa.created"`, `digitalSourceType: "digitalCapture"` |
| Device info | `attestation.device` | Device model, OS version, hardware trust level |
| Capture time | `attestation.capture_time` | ISO 8601 timestamp |
| Trust metadata | `attestation.trust` | Trust level and server nonce (when provided) |
| Location | `stds.exif` | GPS latitude/longitude (when `includeLocation` is true) |

### Verifying output

Upload the output JPEG to [verify.contentauthenticity.org](https://verify.contentauthenticity.org) or use the CLI:

```bash
cargo install c2patool
c2patool verify output.jpg
```

The verifier will show a valid signature with an unknown signer. This is expected for self-signed certificates. See [Security model](#security-model) below.

## Error codes

| Code | When |
|---|---|
| `E_COMPROMISED_DEVICE` | Device shows signs of jailbreak or root. Capture is blocked. |
| `E_NO_TRUSTED_HARDWARE` | No Secure Enclave, StrongBox, or TEE available and `requireTrustedHardware` is `true`. |
| `E_ATTESTATION_FAILED` | Hardware key provisioning failed. |
| `E_CAPTURE_FAILED` | Camera capture or file I/O failed. |
| `E_SIGNING_FAILED` | Hardware signing operation rejected. |
| `E_C2PA_EMBED_FAILED` | C2PA manifest could not be built or embedded. |

## Security model

### What is protected

| Threat | Mitigation |
|---|---|
| **Key extraction** | Private keys are generated inside Secure Enclave (iOS) or StrongBox/TEE (Android). They are non-exportable by hardware design. |
| **Post-capture tampering** | The C2PA manifest contains a cryptographic hash of the image data. Any modification to the JPEG invalidates the signature. |
| **Unsigned file window** | The pipeline writes the signed JPEG atomically. No unsigned version touches disk. |
| **Replay attacks** | Pass a server-issued `nonce` prop. It is embedded in the manifest and bound to the signature. |
| **Compromised devices** | Capture is blocked by default on jailbroken or rooted devices. |
| **Algorithm downgrade** | The SDK uses ECDSA P-256 with SHA-256 (ES256) exclusively. There is no algorithm negotiation. |

### What is NOT protected

These are known limitations. Understand them before relying on this SDK for high-assurance use cases.

| Gap | Description | Impact |
|---|---|---|
| **Self-signed certificates** | The signing key has a self-signed X.509 certificate. There is no certificate authority chain. Any C2PA verifier will report an unknown signer. | A verifier can confirm the image has not been tampered with, but cannot confirm *who* signed it. Attribution requires a CA integration (not yet implemented). |
| **Screen capture / camera injection** | On a compromised or rooted device (even one that bypasses root detection), an attacker could feed synthetic frames to the camera API. The SDK signs whatever the camera returns. | The signature proves this device signed these bytes, not that these bytes came from the physical lens. This is a fundamental platform limitation, not specific to this SDK. |
| **Root detection is heuristic** | Jailbreak and root detection uses basic signals (`test-keys` on Android, simulator check on iOS). Sophisticated root hides are not detected. | A determined attacker on a rooted device can bypass the compromised-device block. Consider layering with Play Integrity (Android) or App Attest (iOS) for higher assurance. |
| **No timestamping authority (TSA)** | The capture timestamp is self-reported by the device clock. There is no countersignature from a trusted time server. | An attacker who controls the device can set the clock to any value. The manifest timestamp is credible but not independently verifiable. |
| **OS-level memory access** | On a rooted device, another process with root privileges could read or modify the JPEG bytes in memory before signing completes. | Hardware-backed signing is intact, but the data being signed could be substituted. This requires root and is mitigated by the compromised-device check. |
| **No remote attestation** | The SDK does not verify the device's boot chain or OS integrity with a remote server. | The `trustLevel` field is self-reported. A rooted device could lie about its hardware backing. Remote attestation (Play Integrity / App Attest) closes this gap. |
| **No video support** | This SDK is photo-only. Video recording is not attested. See [Photo only, no video](#photo-only-no-video) below. | If your app also records video, those files will have no C2PA manifest or hardware-backed signature. |

### Photo only, no video

This SDK captures and signs **still photos only**. Video recording is not supported.

### Trust levels

| Level | Platform | Meaning |
|---|---|---|
| `secure_enclave` | iOS | Key is in the Secure Enclave coprocessor. Highest iOS trust. |
| `strongbox` | Android | Key is in a dedicated tamper-resistant chip. Highest Android trust. |
| `tee` | Android | Key is in the Trusted Execution Environment. High trust, but the TEE shares the main processor. |
| `software_fallback` | Both | Key is in software (simulator, emulator, or unsupported hardware). Not suitable for production attestation. |

## Project structure

```
src/                  TypeScript API surface (headless)
  nativeBridge.ts     Native module bridge
  types.ts            Type definitions (SignedPhoto, errors, params)

native/
  ios/                Swift native module (Secure Enclave, ASN.1 cert builder)
  android/            Kotlin native module (AndroidKeyStore, StrongBox)

rust/
  src/lib.rs          Rust core (C2PA builder, SHA-256, Signer adapter)
  src/attestation_mobile.udl   UniFFI interface definition
  Cargo.toml          Dependencies (c2pa, sha2, uniffi)

example/
  src/                Camera UI components (AttestedCamera, CameraControls)
  App.tsx             Demo app showing full camera + attestation flow
```

## Platform requirements

| Platform | Minimum | Recommended |
|---|---|---|
| iOS | 14.0 | 16.0+ |
| Android | API 28 (9.0) | API 30+ (11.0+) for higher StrongBox availability |
| Rust | 1.75.0 | stable |
| Node | 18 | 22 |

## Development

```bash
# Install dependencies
npm install --legacy-peer-deps

# TypeScript
npm run typecheck          # Type check only
npm run lint               # ESLint
npm run build              # Compile to dist/

# Rust
npm run rust:check         # cargo check
npm run rust:clippy        # cargo clippy
npm run rust:fmt           # cargo fmt

# Everything
npm run check              # typecheck + lint + rust:check
```

### Build & run the example app

A `Makefile` automates building and deploying the example app to a physical device:

```
make help              Show available commands
make devices           List connected iOS and Android devices

make ios-build         Build iOS release for connected iPhone
make ios-run           Build, install and launch on connected iPhone
make ios-open          Open Xcode workspace (for manual signing setup)

make android-apk       Build Android release APK
make android-install   Build and install APK on connected Android device

make clean             Remove all build artifacts
```

**iOS first-time setup:** Run `make ios-open`, select your Apple ID team under Signing & Capabilities, then plug in your iPhone and run `make ios-run`.

## License

[MIT](./LICENSE)
