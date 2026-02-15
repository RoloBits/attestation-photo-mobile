import type { StyleProp, ViewStyle } from "react-native";

export type PlatformTrustLevel =
  | "secure_enclave"
  | "strongbox"
  | "tee"
  | "software_fallback";

export type CaptureSecurityStatus =
  | "trusted_hardware"
  | "trusted_tee"
  | "degraded"
  | "blocked";

export interface CaptureLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

export interface CaptureMetadata {
  deviceModel: string;
  osVersion: string;
  capturedAtIso8601: string;
  sourceSha256?: string;
  pipelineMode?: "camera-file-bridge" | "frame-processor-atomic" | "c2pa-atomic";
  location?: CaptureLocation;
  nonce?: string;
}

export interface SignedPhoto {
  path: string;
  signature: string;
  algorithm: "ECDSA_P256_SHA256";
  manifestFormat: "c2pa-jumbf";
  trustLevel: PlatformTrustLevel;
  metadata: CaptureMetadata;
  /** True when the JPEG contains a real embedded C2PA/JUMBF manifest */
  embeddedManifest?: boolean;
}

export interface AttestationStatus {
  isPhysicalDevice: boolean;
  isCompromised: boolean;
  trustLevel: PlatformTrustLevel;
}

export interface AttestedCameraError extends Error {
  code:
    | "E_COMPROMISED_DEVICE"
    | "E_NO_TRUSTED_HARDWARE"
    | "E_ATTESTATION_FAILED"
    | "E_CAPTURE_FAILED"
    | "E_SIGNING_FAILED"
    | "E_C2PA_EMBED_FAILED";
}

export interface AttestedCameraProps {
  onCapture: (photo: SignedPhoto) => void;
  onError?: (error: AttestedCameraError) => void;
  onCaptureStart?: () => void;
  onLog?: (message: string) => void;
  style?: StyleProp<ViewStyle>;
  includeLocation?: boolean;
  nonce?: string;
  requireTrustedHardware?: boolean;
  cameraPosition?: "back" | "front";
  /** Show white flash effect on capture. Default: true */
  showFlash?: boolean;
  /** App name shown in C2PA Content Credentials (signer identity, manifest, author). Default: "Attestation Mobile" */
  appName?: string;
}
