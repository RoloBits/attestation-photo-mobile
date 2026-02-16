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

Every photo taken through this SDK is signed by the device's tamper-resistant hardware, Secure Enclave on iOS and StrongBox/TEE on Android, and embedded with a [C2PA](https://c2pa.org/) manifest before the file is ever written to disk. The resulting JPEG can be verified with any standard C2PA tool.

## Install

### 1. npm

```bash
npm install @rolobits/attestation-photo-mobile
```

| Peer dependency | Version |
|---|---|
| `react` | >= 18 |
| `react-native` | >= 0.73 |

### 2. Rust toolchain, one-time setup

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

| Permission | iOS `Info.plist` | Android `AndroidManifest.xml` | Required? |
|---|---|---|---|
| Camera | `NSCameraUsageDescription` | `android.permission.CAMERA` | Yes |
| Location | `NSLocationWhenInUseUsageDescription` | `android.permission.ACCESS_FINE_LOCATION` | Only with `includeLocation: true` |

## Quick start

This library is headless. It handles attestation and signing only. You bring your own camera like `react-native-vision-camera`, `expo-camera`, or any source that produces a JPEG path. See the [example app](./example/) for a full camera UI implementation.

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

## Verifying output

Upload the output JPEG to [verify.contentauthenticity.org](https://verify.contentauthenticity.org) or use the CLI:

```bash
cargo install c2patool
c2patool verify output.jpg
```

The verifier will show a valid signature with an unknown signer. This is expected for self-signed certificates. See [Limitations](#limitations) below.

## Error codes

| Code | When |
|---|---|
| `E_COMPROMISED_DEVICE` | Device shows signs of jailbreak or root. Capture is blocked. |
| `E_NO_TRUSTED_HARDWARE` | No Secure Enclave, StrongBox, or TEE available and `requireTrustedHardware` is `true`. |
| `E_ATTESTATION_FAILED` | Hardware key provisioning failed. |
| `E_CAPTURE_FAILED` | Camera capture or file I/O failed. |
| `E_SIGNING_FAILED` | Hardware signing operation rejected. |
| `E_C2PA_EMBED_FAILED` | C2PA manifest could not be built or embedded. |

## Limitations

Understand these gaps before relying on this SDK for high-assurance use cases.

- **Self-signed certificates** — The signing key has a self-signed X.509 certificate with no CA chain. Verifiers will report an unknown signer. Tamper detection works, but attribution requires a CA integration (not yet implemented).
- **Camera injection** — On a compromised device, an attacker could feed synthetic frames to the camera API. The SDK signs whatever the camera returns.
- **Heuristic root detection** — Jailbreak/root detection uses basic signals. Sophisticated root hides are not detected. Consider layering with Play Integrity (Android) or App Attest (iOS) for higher assurance.
- **No timestamping authority** — The capture timestamp is self-reported by the device clock. There is no countersignature from a trusted time server.
- **No remote attestation** — The SDK does not verify the device's boot chain or OS integrity with a remote server. The `trustLevel` field is self-reported.
- **Photo only** — Video recording is not supported or attested.

## Platform requirements

| Platform | Minimum | Recommended |
|---|---|---|
| iOS | 14.0 | 16.0+ |
| Android | API 28 / Android 9 | API 30+ / Android 11+ for higher StrongBox availability |
| Rust | 1.75.0 | stable |
| Node | 18 | 22 |

## License

[MIT](./LICENSE)
