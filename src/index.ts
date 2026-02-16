export {
  captureAndSignAtomic,
  ensureHardwareKey,
  getAttestationStatus,
  hashPhotoAtPath,
  prefetchLocation,
  saveToGallery,
  signPayload
} from "./nativeBridge";
export { useAttestedCapture } from "./useAttestedCapture";
export type {
  UseAttestedCaptureOptions,
  UseAttestedCaptureResult
} from "./useAttestedCapture";
export type {
  AttestationStatus,
  AttestedCameraError,
  CaptureAndSignParams,
  CaptureLocation,
  CaptureMetadata,
  HashPhotoAtPathParams,
  PlatformTrustLevel,
  SaveToGalleryParams,
  SignedPhoto,
  SignPayloadParams
} from "./types";
