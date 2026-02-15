# Atomic C2PA Mobile SDK Architecture (Draft v1.0)

## Scope
- Package: `@RoloBits/attestation-photo-mobile`
- Platforms: iOS + Android
- Objective: produce a `.jpg` with embedded C2PA manifest where image bytes are signed by hardware-backed keys before the file is written.

## Non-Negotiable Security Constraints
- The private key must be non-exportable and hardware-backed.
- The hash used for signing must be computed from in-memory camera bytes.
- Signature generation and C2PA embedding must occur before final disk write.
- Captures on compromised devices are blocked by default.

## Data Flow (Target)
1. Camera API provides frame buffer in native memory.
2. Frame processor freezes selected frame bytes for capture.
3. Rust core computes SHA-256 over bytes in memory.
4. Native signer requests hardware key operation over hash.
5. Rust C2PA builder creates JUMBF manifest with claims:
   - device model
   - OS version
   - timestamp
   - optional GPS
   - optional server nonce
   - trust level (`secure_enclave`, `strongbox`, `tee`)
6. Final JPEG bytes are persisted once the manifest is embedded.

## Trust Model
- iOS:
  - Preferred: Secure Enclave key.
  - Device integrity: App Attest + jailbreak checks.
- Android:
  - Preferred: StrongBox.
  - Fallback: TEE with explicit degraded trust claim.
  - Device integrity: Play Integrity + root checks.

## Public API Stability
- `AttestedCamera` props and `SignedPhoto` shape should remain stable across native rewrites.
- Future additions should be additive and optional.
