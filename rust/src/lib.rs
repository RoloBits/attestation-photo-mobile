#![allow(clippy::empty_line_after_doc_comments)] // UniFFI generated code triggers this

use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::io::Cursor;

// NOTE: Thread-local error detail — `set_error_detail` and `take_error_detail`
// must be called on the same thread. This is safe today because
// `build_and_sign_c2pa` runs synchronously on a single thread, but would
// need refactoring if errors are ever formatted on a different thread.
thread_local! {
    static LAST_ERROR_DETAIL: RefCell<String> = RefCell::new(String::new());
}

fn set_error_detail(detail: String) {
    LAST_ERROR_DETAIL.with(|cell| {
        *cell.borrow_mut() = detail;
    });
}

fn take_error_detail() -> String {
    LAST_ERROR_DETAIL.with(|cell| {
        cell.borrow_mut().split_off(0)
    })
}

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
    pub app_name: String,
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
    JpegValidationFailed,
}

impl std::fmt::Display for AttestationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let detail = take_error_detail();
        match self {
            Self::SigningFailed => {
                if detail.is_empty() {
                    write!(f, "Signing failed")
                } else {
                    write!(f, "Signing failed: {}", detail)
                }
            }
            Self::ManifestBuildFailed => {
                if detail.is_empty() {
                    write!(f, "Manifest build failed")
                } else {
                    write!(f, "Manifest build failed: {}", detail)
                }
            }
            Self::CertificateError => write!(f, "Certificate error"),
            Self::JpegEmbedFailed => {
                if detail.is_empty() {
                    write!(f, "JPEG embed failed")
                } else {
                    write!(f, "JPEG embed failed: {}", detail)
                }
            }
            Self::JpegValidationFailed => write!(f, "JPEG validation failed: not a valid JPEG"),
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
        let der_sig = self
            .inner
            .sign(data.to_vec())
            .map_err(|e| c2pa::Error::BadParam(format!("Hardware signer error: {}", e)))?;

        // Convert DER-encoded ECDSA signature to P1363 (r || s, 64 bytes) for ES256.
        // COSE natively expects P1363 format; this avoids c2pa's internal DER→P1363 fixup.
        der_to_p1363_es256(&der_sig)
            .map_err(|e| c2pa::Error::BadParam(format!("DER→P1363 conversion error: {}", e)))
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

/// Convert a DER-encoded ECDSA signature to P1363 format (r || s, 64 bytes for ES256).
/// DER format: SEQUENCE { INTEGER r, INTEGER s }
/// P1363 format: r (32 bytes, zero-padded) || s (32 bytes, zero-padded)
fn der_to_p1363_es256(der: &[u8]) -> Result<Vec<u8>, String> {
    // Minimum: 30 06 02 01 r 02 01 s = 8 bytes
    if der.len() < 8 || der[0] != 0x30 {
        return Err("not a DER SEQUENCE".into());
    }

    // Parse outer SEQUENCE length
    let (seq_len, offset) = parse_der_length(&der[1..])?;
    let seq_body = &der[1 + offset..];
    if seq_body.len() < seq_len {
        return Err("DER SEQUENCE truncated".into());
    }
    let seq_body = &seq_body[..seq_len];

    // Parse INTEGER r
    if seq_body.is_empty() || seq_body[0] != 0x02 {
        return Err("expected INTEGER tag for r".into());
    }
    let (r_len, r_off) = parse_der_length(&seq_body[1..])?;
    let r_start = 1 + r_off;
    if seq_body.len() < r_start + r_len {
        return Err("r INTEGER truncated".into());
    }
    let r_bytes = &seq_body[r_start..r_start + r_len];

    // Parse INTEGER s
    let s_tag_pos = r_start + r_len;
    if seq_body.len() <= s_tag_pos || seq_body[s_tag_pos] != 0x02 {
        return Err("expected INTEGER tag for s".into());
    }
    let (s_len, s_off) = parse_der_length(&seq_body[s_tag_pos + 1..])?;
    let s_start = s_tag_pos + 1 + s_off;
    if seq_body.len() < s_start + s_len {
        return Err("s INTEGER truncated".into());
    }
    let s_bytes = &seq_body[s_start..s_start + s_len];

    // Pad/trim each integer to exactly 32 bytes (ES256 = P-256 = 32-byte field)
    let r = int_to_fixed(r_bytes, 32)?;
    let s = int_to_fixed(s_bytes, 32)?;

    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&r);
    out.extend_from_slice(&s);
    Ok(out)
}

/// Parse a DER length field. Returns (length_value, bytes_consumed).
fn parse_der_length(data: &[u8]) -> Result<(usize, usize), String> {
    if data.is_empty() {
        return Err("empty DER length".into());
    }
    if data[0] < 0x80 {
        Ok((data[0] as usize, 1))
    } else if data[0] == 0x81 {
        if data.len() < 2 {
            return Err("truncated DER length".into());
        }
        Ok((data[1] as usize, 2))
    } else if data[0] == 0x82 {
        if data.len() < 3 {
            return Err("truncated DER length".into());
        }
        Ok((((data[1] as usize) << 8) | data[2] as usize, 3))
    } else {
        Err("unsupported DER length encoding".into())
    }
}

/// Strip leading zeros from an ASN.1 INTEGER and left-pad to `size` bytes.
fn int_to_fixed(bytes: &[u8], size: usize) -> Result<Vec<u8>, String> {
    // Strip leading zero bytes (ASN.1 adds 0x00 to keep positive)
    let stripped = match bytes.iter().position(|&b| b != 0) {
        Some(pos) => &bytes[pos..],
        None => &[0u8], // all zeros
    };
    if stripped.len() > size {
        return Err(format!(
            "integer too large: {} bytes, expected ≤ {}",
            stripped.len(),
            size
        ));
    }
    let mut out = vec![0u8; size];
    out[size - stripped.len()..].copy_from_slice(stripped);
    Ok(out)
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
    // Extract manufacturer (first word) from device_model, e.g. "Samsung" from "Samsung Galaxy S24"
    let make = context
        .device_model
        .split_whitespace()
        .next()
        .unwrap_or(&context.device_model);

    // Build EXIF data — always include camera info, optionally add GPS
    let mut exif_data = serde_json::json!({
        "@context": {
            "exif": "http://ns.adobe.com/exif/1.0/"
        },
        "exif:Make": make,
        "exif:Model": context.device_model,
        "exif:DateTimeOriginal": context.captured_at_iso8601
    });

    if let (Some(lat), Some(lon)) = (context.latitude, context.longitude) {
        exif_data["exif:GPSVersionID"] = serde_json::json!("2.2.0.0");
        exif_data["exif:GPSLatitude"] = serde_json::json!(decimal_to_exif_dms(lat, true));
        exif_data["exif:GPSLongitude"] = serde_json::json!(decimal_to_exif_dms(lon, false));
        exif_data["exif:GPSTimeStamp"] = serde_json::json!(context.captured_at_iso8601);
    }

    let mut assertions = vec![
        serde_json::json!({
            "label": "c2pa.actions",
            "data": {
                "actions": [{
                    "action": "c2pa.created",
                    "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
                    "softwareAgent": {
                        "name": context.app_name,
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }]
            }
        }),
        serde_json::json!({
            "label": "stds.schema-org.CreativeWork",
            "data": {
                "@context": "https://schema.org",
                "@type": "CreativeWork",
                "author": [{
                    "@type": "Organization",
                    "name": context.app_name
                }]
            }
        }),
        serde_json::json!({
            "label": "stds.exif",
            "data": exif_data
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

    let manifest_def = serde_json::json!({
        "title": format!("Attested Photo {}", context.captured_at_iso8601),
        "format": "image/jpeg",
        "claim_generator_info": [{
            "name": context.app_name,
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
    #[cfg(debug_assertions)]
    eprintln!(
        "[attestation-mobile] build_and_sign_c2pa: jpeg_bytes.len={}, first_4={:02X?}",
        jpeg_bytes.len(),
        &jpeg_bytes[..std::cmp::min(4, jpeg_bytes.len())]
    );

    if jpeg_bytes.len() < 2 || jpeg_bytes[0] != 0xFF || jpeg_bytes[1] != 0xD8 {
        #[cfg(debug_assertions)]
        eprintln!(
            "[attestation-mobile] JPEG validation failed: expected SOI FF D8, got {:02X?}",
            &jpeg_bytes[..std::cmp::min(2, jpeg_bytes.len())]
        );
        return Err(AttestationError::JpegValidationFailed);
    }

    let adapter = HardwareSignerAdapter::new(signer)?;

    let asset_hash = hash_bytes(&jpeg_bytes);
    let manifest_json = build_manifest_definition(&context);

    #[cfg(debug_assertions)]
    eprintln!("[attestation-mobile] manifest_json: {}", &manifest_json[..std::cmp::min(200, manifest_json.len())]);

    let mut builder = c2pa::Builder::from_json(&manifest_json)
        .map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[attestation-mobile] Builder::from_json error: {:?}", e);
            set_error_detail(format!("{:?}", e));
            AttestationError::ManifestBuildFailed
        })?;

    let mut source = Cursor::new(&jpeg_bytes);
    let mut dest = Cursor::new(Vec::new());

    #[cfg(debug_assertions)]
    eprintln!("[attestation-mobile] calling builder.sign with {} bytes of JPEG...", jpeg_bytes.len());

    builder
        .sign(&adapter, "image/jpeg", &mut source, &mut dest)
        .map_err(|e| {
            #[cfg(debug_assertions)]
            eprintln!("[attestation-mobile] builder.sign error: {:?}", e);
            set_error_detail(format!("{:?}", e));
            match &e {
                c2pa::Error::BadParam(_) => AttestationError::SigningFailed,
                _ => AttestationError::JpegEmbedFailed,
            }
        })?;

    #[cfg(debug_assertions)]
    eprintln!("[attestation-mobile] sign succeeded, output {} bytes", dest.get_ref().len());

    Ok(C2paSignedPhoto {
        signed_jpeg: dest.into_inner(),
        manifest_json,
        asset_hash_hex: asset_hash.sha256_hex,
    })
}
