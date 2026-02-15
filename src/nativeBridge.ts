import { NativeModules, Platform } from "react-native";
import type { AttestationStatus, SignedPhoto } from "./types";

interface NativeAttestationModule {
  getAttestationStatus(): Promise<AttestationStatus>;
  ensureHardwareKey(): Promise<{ trustLevel: AttestationStatus["trustLevel"] }>;
  signPayload(params: { payloadBase64: string }): Promise<{
    signatureBase64: string;
    trustLevel: AttestationStatus["trustLevel"];
  }>;
  hashPhotoAtPath(params: { sourcePhotoPath: string }): Promise<{ sha256Hex: string }>;
  captureAndSignAtomic(params: {
    includeLocation: boolean;
    nonce?: string;
    sourcePhotoPath: string;
    latitude?: number;
    longitude?: number;
    appName?: string;
  }): Promise<SignedPhoto>;
  saveToGallery(params: {
    filePath: string;
    fileName?: string;
  }): Promise<{ uri: string }>;
}

const moduleName =
  Platform.OS === "ios" || Platform.OS === "android"
    ? "RNAttestationMobile"
    : "";

const nativeModule: NativeAttestationModule | undefined = moduleName
  ? (NativeModules[moduleName] as NativeAttestationModule | undefined)
  : undefined;

export function requireNativeModule(): NativeAttestationModule {
  if (!nativeModule) {
    throw new Error(
      "Native attestation module is not linked. iOS/Android native implementation is required."
    );
  }
  return nativeModule;
}
