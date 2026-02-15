#![allow(clippy::empty_line_after_doc_comments)] // UniFFI generated code triggers this

use sha2::{Digest, Sha256};
use std::io::Cursor;

// ---------------------------------------------------------------------------
// Callback interface trait (must be defined before scaffolding include)
// UniFFI's export_for_udl(callback_interface) macro generates the FFI glue
// but expects the trait to already exist in scope.
// ---------------------------------------------------------------------------

pub trait HardwareSigner: Send + Sync {
    fn sign(&self, data: Vec<u8>) -> Result<Vec<u8>, SignerError>;
    fn certificate_der(&self) -> Result<Vec<u8>, SignerError>;
}

uniffi::include_scaffolding!("attestation_mobile");

// ---------------------------------------------------------------------------
// Existing types (backward compatible)
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct AtomicHashResult {
    pub sha256_hex: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct AtomicSignedArtifact {
    pub jpg_bytes: Vec<u8>,
    pub manifest_json: String,
}

// ---------------------------------------------------------------------------
// New C2PA pipeline types
// ---------------------------------------------------------------------------

pub struct C2paSignedPhoto {
    pub signed_jpeg: Vec<u8>,
    pub manifest_json: String,
    pub asset_hash_hex: String,
}

pub struct CaptureContext {
    pub device_model: String,
    pub os_version: String,
    pub captured_at_iso8601: String,
    pub trust_level: String,
    pub nonce: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum AttestationError {
    SigningFailed,
    ManifestBuildFailed,
    CertificateError,
    JpegEmbedFailed,
}

impl std::fmt::Display for AttestationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SigningFailed => write!(f, "Signing failed"),
            Self::ManifestBuildFailed => write!(f, "Manifest build failed"),
            Self::CertificateError => write!(f, "Certificate error"),
            Self::JpegEmbedFailed => write!(f, "JPEG embed failed"),
        }
    }
}

impl std::error::Error for AttestationError {}

#[derive(Debug)]
pub enum SignerError {
    HardwareUnavailable,
    KeyNotFound,
    SignatureOperationFailed,
    CertificateExportFailed,
}

impl std::fmt::Display for SignerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::HardwareUnavailable => write!(f, "Hardware unavailable"),
            Self::KeyNotFound => write!(f, "Key not found"),
            Self::SignatureOperationFailed => write!(f, "Signature operation failed"),
            Self::CertificateExportFailed => write!(f, "Certificate export failed"),
        }
    }
}

impl std::error::Error for SignerError {}

// ---------------------------------------------------------------------------
// HardwareSignerAdapter: wraps UniFFI callback to implement c2pa::Signer
// ---------------------------------------------------------------------------

struct HardwareSignerAdapter {
    inner: Box<dyn HardwareSigner>,
    cached_cert: Vec<u8>,
}

impl HardwareSignerAdapter {
    fn new(signer: Box<dyn HardwareSigner>) -> Result<Self, AttestationError> {
        let cached_cert = signer
            .certificate_der()
            .map_err(|_| AttestationError::CertificateError)?;
        Ok(Self {
            inner: signer,
            cached_cert,
        })
    }
}

impl c2pa::Signer for HardwareSignerAdapter {
    fn sign(&self, data: &[u8]) -> c2pa::Result<Vec<u8>> {
        self.inner
            .sign(data.to_vec())
            .map_err(|e| c2pa::Error::BadParam(format!("Hardware signer error: {}", e)))
    }

    fn alg(&self) -> c2pa::SigningAlg {
        c2pa::SigningAlg::Es256
    }

    fn certs(&self) -> c2pa::Result<Vec<Vec<u8>>> {
        Ok(vec![self.cached_cert.clone()])
    }

    fn reserve_size(&self) -> usize {
        10240
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert decimal degrees to EXIF DMS string (e.g., `"39,21.102N"`).
fn decimal_to_exif_dms(degrees: f64, is_latitude: bool) -> String {
    let abs = degrees.abs();
    let d = abs.floor() as u32;
    let minutes = (abs - d as f64) * 60.0;
    let suffix = if is_latitude {
        if degrees >= 0.0 { 'N' } else { 'S' }
    } else if degrees >= 0.0 {
        'E'
    } else {
        'W'
    };
    format!("{},{:.3}{}", d, minutes, suffix)
}

/// Internal hash helper that borrows a slice (avoids cloning).
fn hash_bytes(data: &[u8]) -> AtomicHashResult {
    let mut hasher = Sha256::new();
    hasher.update(data);
    AtomicHashResult {
        sha256_hex: hex::encode(hasher.finalize()),
    }
}

// ---------------------------------------------------------------------------
// Manifest builder
// ---------------------------------------------------------------------------

fn build_manifest_definition(context: &CaptureContext) -> String {
    let mut assertions = vec![
        serde_json::json!({
            "label": "c2pa.actions",
            "data": {
                "actions": [{
                    "action": "c2pa.created",
                    "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
                    "softwareAgent": {
                        "name": "Attestation Mobile",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }]
            }
        }),
        serde_json::json!({
            "label": "attestation.device",
            "data": {
                "deviceModel": context.device_model,
                "osVersion": context.os_version,
                "trustLevel": context.trust_level
            }
        }),
        serde_json::json!({
            "label": "attestation.capture_time",
            "data": {
                "timestamp": context.captured_at_iso8601
            }
        }),
    ];

    if let Some(ref nonce) = context.nonce {
        assertions.push(serde_json::json!({
            "label": "attestation.trust",
            "data": {
                "trustLevel": context.trust_level,
                "nonce": nonce
            }
        }));
    }

    if let (Some(lat), Some(lon)) = (context.latitude, context.longitude) {
        assertions.push(serde_json::json!({
            "label": "stds.exif",
            "data": {
                "@context": {
                    "exif": "http://ns.adobe.com/exif/1.0/"
                },
                "exif:GPSLatitude": decimal_to_exif_dms(lat, true),
                "exif:GPSLongitude": decimal_to_exif_dms(lon, false)
            }
        }));
    }

    let manifest_def = serde_json::json!({
        "claim_generator_info": [{
            "name": "Attestation Mobile",
            "version": env!("CARGO_PKG_VERSION")
        }],
        "assertions": assertions
    });

    manifest_def.to_string()
}

// ---------------------------------------------------------------------------
// Existing functions (backward compatible)
// ---------------------------------------------------------------------------

pub fn hash_frame_bytes(frame_bytes: Vec<u8>) -> AtomicHashResult {
    hash_bytes(&frame_bytes)
}

pub fn build_c2pa_placeholder(
    jpg_bytes: Vec<u8>,
    signature_base64: String,
    metadata_json: String,
) -> AtomicSignedArtifact {
    let digest = hash_bytes(&jpg_bytes);
    let manifest = serde_json::json!({
        "type": "c2pa-placeholder",
        "alg": "ECDSA_P256_SHA256",
        "sha256": digest.sha256_hex,
        "signature": signature_base64,
        "metadata": serde_json::from_str::<serde_json::Value>(&metadata_json)
            .unwrap_or_else(|_| serde_json::json!({})),
    });
    AtomicSignedArtifact {
        jpg_bytes,
        manifest_json: manifest.to_string(),
    }
}

// ---------------------------------------------------------------------------
// New: Full C2PA pipeline with embedded JUMBF manifest
// ---------------------------------------------------------------------------

pub fn build_and_sign_c2pa(
    jpeg_bytes: Vec<u8>,
    context: CaptureContext,
    signer: Box<dyn HardwareSigner>,
) -> Result<C2paSignedPhoto, AttestationError> {
    if jpeg_bytes.len() < 2 || jpeg_bytes[0] != 0xFF || jpeg_bytes[1] != 0xD8 {
        return Err(AttestationError::JpegEmbedFailed);
    }

    let adapter = HardwareSignerAdapter::new(signer)?;

    let asset_hash = hash_bytes(&jpeg_bytes);
    let manifest_json = build_manifest_definition(&context);

    let mut builder = c2pa::Builder::from_json(&manifest_json)
        .map_err(|_| AttestationError::ManifestBuildFailed)?;

    let mut source = Cursor::new(&jpeg_bytes);
    let mut dest = Cursor::new(Vec::new());

    builder
        .sign(&adapter, "image/jpeg", &mut source, &mut dest)
        .map_err(|e| match &e {
            c2pa::Error::BadParam(_) => AttestationError::SigningFailed,
            _ => AttestationError::JpegEmbedFailed,
        })?;

    Ok(C2paSignedPhoto {
        signed_jpeg: dest.into_inner(),
        manifest_json,
        asset_hash_hex: asset_hash.sha256_hex,
    })
}
