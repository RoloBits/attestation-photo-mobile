export {
  captureAndSignAtomic,
  ensureHardwareKey,
  getAttestationStatus,
  hashPhotoAtPath,
  saveToGallery,
  signPayload
} from "./nativeBridge";
export type {
  AttestationStatus,
  AttestedCameraError,
  CaptureAndSignParams,
  CaptureMetadata,
  HashPhotoAtPathParams,
  PlatformTrustLevel,
  SaveToGalleryParams,
  SignedPhoto,
  SignPayloadParams
} from "./types";
