import type { StyleProp, ViewStyle } from "react-native";
import type { SignedPhoto } from "@rolobits/attestation-photo-mobile";

export type FlashMode = "off" | "on" | "auto";
export type PhotoQuality = "speed" | "balanced" | "quality";

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
  style?: StyleProp<ViewStyle>;
  includeLocation?: boolean;
  nonce?: string;
  requireTrustedHardware?: boolean;
  cameraPosition?: "back" | "front";
  /** Show white flash effect on capture. Default: true */
  showFlash?: boolean;
  /** App name shown in C2PA Content Credentials (signer identity, manifest, author). Default: "Attestation Mobile" */
  appName?: string;

  // --- Camera controls (all default false/off) ---
  /** Enable native pinch-to-zoom */
  enableZoomGesture?: boolean;
  /** Show vertical zoom slider on right edge */
  enableZoomSlider?: boolean;
  /** Enable tap-to-focus with animated reticle */
  enableFocusTap?: boolean;
  /** Show torch toggle button */
  enableTorch?: boolean;
  /** Show flash mode cycle button (off/on/auto) */
  enableFlashMode?: boolean;
  /** Show front/back camera toggle button */
  enableCameraSwitch?: boolean;
  /** Show vertical exposure bias slider */
  enableExposureSlider?: boolean;
  /** Show photo quality cycle button (speed/balanced/quality) */
  enableQualitySelector?: boolean;
  /** Starting flash mode. Default: 'off' */
  initialFlashMode?: FlashMode;
  /** Starting photo quality. Default: 'balanced' */
  initialPhotoQuality?: PhotoQuality;
  /** Called when zoom level changes */
  onZoomChange?: (zoom: number) => void;
  /** Called when flash mode changes */
  onFlashModeChange?: (mode: FlashMode) => void;
  /** Called when camera position changes */
  onCameraPositionChange?: (position: "back" | "front") => void;
  /** Top safe area inset in points (to avoid status bar / Dynamic Island). Default: 54 on iOS, StatusBar.currentHeight on Android */
  safeAreaTop?: number;
}
