import { useCallback, useEffect, useRef, useState } from "react";
import type { CameraDevice } from "react-native-vision-camera";
import type { FlashMode, PhotoQuality } from "./types";

export interface FocusPoint {
  x: number;
  y: number;
  key: number;
}

export interface CameraControlsState {
  zoom: number;
  torch: "off" | "on";
  flashMode: FlashMode;
  exposure: number;
  photoQuality: PhotoQuality;
  focusPoint: FocusPoint | null;
}

export interface CameraControlsActions {
  setZoom: (zoom: number) => void;
  toggleTorch: () => void;
  cycleFlashMode: () => void;
  setExposure: (exposure: number) => void;
  cyclePhotoQuality: () => void;
  handleFocusTap: (x: number, y: number) => void;
  clearFocusPoint: () => void;
}

export interface UseCameraControlsResult {
  state: CameraControlsState;
  actions: CameraControlsActions;
}

const FLASH_MODES: FlashMode[] = ["off", "on", "auto"];
const QUALITY_MODES: PhotoQuality[] = ["speed", "balanced", "quality"];

export function useCameraControls(
  device: CameraDevice | undefined,
  initialFlashMode: FlashMode = "off",
  initialPhotoQuality: PhotoQuality = "balanced",
  onZoomChange?: (zoom: number) => void,
  onFlashModeChange?: (mode: FlashMode) => void
): UseCameraControlsResult {
  const [zoom, setZoomRaw] = useState(device?.neutralZoom ?? 1);
  const [torch, setTorch] = useState<"off" | "on">("off");
  const [flashMode, setFlashMode] = useState<FlashMode>(initialFlashMode);
  const [exposure, setExposureRaw] = useState(0);
  const [photoQuality, setPhotoQuality] =
    useState<PhotoQuality>(initialPhotoQuality);
  const [focusPoint, setFocusPoint] = useState<FocusPoint | null>(null);
  const focusKeyRef = useRef(0);

  // Reset controls when device changes (e.g. front <-> back)
  useEffect(() => {
    if (!device) return;
    setZoomRaw(device.neutralZoom ?? 1);
    setExposureRaw(0);
    setTorch("off");
  }, [device]);

  const setZoom = useCallback(
    (value: number) => {
      if (!device) return;
      const clamped = Math.min(
        Math.max(value, device.minZoom),
        device.maxZoom
      );
      setZoomRaw(clamped);
      onZoomChange?.(clamped);
    },
    [device, onZoomChange]
  );

  const toggleTorch = useCallback(() => {
    setTorch((prev) => (prev === "off" ? "on" : "off"));
  }, []);

  const cycleFlashMode = useCallback(() => {
    setFlashMode((prev) => {
      const idx = FLASH_MODES.indexOf(prev);
      const next = FLASH_MODES[(idx + 1) % FLASH_MODES.length]!;
      onFlashModeChange?.(next);
      return next;
    });
  }, [onFlashModeChange]);

  const setExposure = useCallback(
    (value: number) => {
      if (!device) return;
      const clamped = Math.min(
        Math.max(value, device.minExposure),
        device.maxExposure
      );
      setExposureRaw(clamped);
    },
    [device]
  );

  const cyclePhotoQuality = useCallback(() => {
    setPhotoQuality((prev) => {
      const idx = QUALITY_MODES.indexOf(prev);
      return QUALITY_MODES[(idx + 1) % QUALITY_MODES.length]!;
    });
  }, []);

  const handleFocusTap = useCallback((x: number, y: number) => {
    focusKeyRef.current += 1;
    setFocusPoint({ x, y, key: focusKeyRef.current });
  }, []);

  const clearFocusPoint = useCallback(() => {
    setFocusPoint(null);
  }, []);

  return {
    state: {
      zoom,
      torch,
      flashMode,
      exposure,
      photoQuality,
      focusPoint,
    },
    actions: {
      setZoom,
      toggleTorch,
      cycleFlashMode,
      setExposure,
      cyclePhotoQuality,
      handleFocusTap,
      clearFocusPoint,
    },
  };
}
