import { NativeModules, Platform } from "react-native";
import type {
  AttestationStatus,
  CaptureAndSignParams,
  HashPhotoAtPathParams,
  SaveToGalleryParams,
  SignPayloadParams,
  SignedPhoto
} from "./types";

interface NativeAttestationModule {
  getAttestationStatus(): Promise<AttestationStatus>;
  ensureHardwareKey(): Promise<{ trustLevel: AttestationStatus["trustLevel"] }>;
  signPayload(params: SignPayloadParams): Promise<{
    signatureBase64: string;
    trustLevel: AttestationStatus["trustLevel"];
  }>;
  hashPhotoAtPath(params: HashPhotoAtPathParams): Promise<{ sha256Hex: string }>;
  captureAndSignAtomic(params: CaptureAndSignParams): Promise<SignedPhoto>;
  saveToGallery(params: SaveToGalleryParams): Promise<{ uri: string }>;
}

const moduleName =
  Platform.OS === "ios" || Platform.OS === "android"
    ? "RNAttestationMobile"
    : "";

const nativeModule: NativeAttestationModule | undefined = moduleName
  ? (NativeModules[moduleName] as NativeAttestationModule | undefined)
  : undefined;

function requireNativeModule(): NativeAttestationModule {
  if (!nativeModule) {
    throw new Error(
      "Native attestation module is not linked. iOS/Android native implementation is required."
    );
  }
  return nativeModule;
}

// --- Headless API exports ---

export function getAttestationStatus(): Promise<AttestationStatus> {
  return requireNativeModule().getAttestationStatus();
}

export function ensureHardwareKey(): Promise<{
  trustLevel: AttestationStatus["trustLevel"];
}> {
  return requireNativeModule().ensureHardwareKey();
}

export function captureAndSignAtomic(
  params: CaptureAndSignParams
): Promise<SignedPhoto> {
  return requireNativeModule().captureAndSignAtomic(params);
}

export function saveToGallery(
  params: SaveToGalleryParams
): Promise<{ uri: string }> {
  return requireNativeModule().saveToGallery(params);
}

export function hashPhotoAtPath(
  params: HashPhotoAtPathParams
): Promise<{ sha256Hex: string }> {
  return requireNativeModule().hashPhotoAtPath(params);
}

export function signPayload(
  params: SignPayloadParams
): Promise<{ signatureBase64: string; trustLevel: AttestationStatus["trustLevel"] }> {
  return requireNativeModule().signPayload(params);
}
