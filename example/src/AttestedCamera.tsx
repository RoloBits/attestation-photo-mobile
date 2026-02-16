import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  GestureResponderEvent,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission
} from "react-native-vision-camera";
import {
  captureAndSignAtomic,
  ensureHardwareKey,
  getAttestationStatus
} from "@rolobits/attestation-photo-mobile";
import {
  ExposureSlider,
  FocusIndicator,
  QualitySelector,
  TopBar,
  ZoomSlider
} from "./CameraControls";
import { useCameraControls } from "./useCameraControls";
import type { AttestedCameraError, AttestedCameraProps } from "./types";

function toCameraError(err: unknown): AttestedCameraError {
  const base = err instanceof Error ? err : new Error(String(err));
  const code =
    typeof err === "object" &&
    err &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
      ? ((err as { code: AttestedCameraError["code"] }).code ??
        "E_CAPTURE_FAILED")
      : "E_CAPTURE_FAILED";
  return Object.assign(base, { code });
}

export function AttestedCamera(props: AttestedCameraProps) {
  const {
    onCapture,
    onError,
    onCaptureStart,
    includeLocation = false,
    nonce,
    requireTrustedHardware = true,
    cameraPosition: initialCameraPosition = "back",
    showFlash = true,
    appName,
    enableZoomGesture = false,
    enableZoomSlider = false,
    enableFocusTap = false,
    enableTorch = false,
    enableFlashMode = false,
    enableCameraSwitch = false,
    enableExposureSlider = false,
    enableQualitySelector = false,
    initialFlashMode = "off",
    initialPhotoQuality = "balanced",
    onZoomChange,
    onFlashModeChange,
    onCameraPositionChange,
    safeAreaTop = Platform.OS === "ios" ? 54 : (StatusBar.currentHeight ?? 44)
  } = props;

  const cameraRef = useRef<Camera>(null);
  const [capturingUI, setCapturingUI] = useState(false);
  const capturingRef = useRef(false);
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const { hasPermission, requestPermission } = useCameraPermission();

  // Camera position managed here so useCameraDevice gets the current value
  const [cameraPosition, setCameraPosition] =
    useState<"back" | "front">(initialCameraPosition);
  const device = useCameraDevice(cameraPosition);

  const { state, actions } = useCameraControls(
    device,
    initialFlashMode,
    initialPhotoQuality,
    onZoomChange,
    onFlashModeChange
  );

  const toggleCameraPosition = useCallback(() => {
    setCameraPosition((prev) => {
      const next = prev === "back" ? "front" : "back";
      onCameraPositionChange?.(next);
      return next;
    });
  }, [onCameraPositionChange]);

  const triggerFlash = useCallback(() => {
    if (!showFlash) return;
    flashOpacity.setValue(1);
    Animated.timing(flashOpacity, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true
    }).start();
  }, [flashOpacity, showFlash]);

  const handleTouchEnd = useCallback(
    (e: GestureResponderEvent) => {
      if (!enableFocusTap || !cameraRef.current || !device) return;
      // Only handle single-finger taps
      if (e.nativeEvent.touches?.length > 0) return;
      const { locationX, locationY } = e.nativeEvent;
      actions.handleFocusTap(locationX, locationY);
      cameraRef.current.focus({ x: locationX, y: locationY }).catch(() => {});
    },
    [enableFocusTap, device, actions]
  );

  const onPressCapture = useCallback(async () => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    setCapturingUI(true);
    onCaptureStart?.();
    try {
      if (!hasPermission) {
        const granted = await requestPermission();
        if (!granted) {
          throw Object.assign(new Error("Camera permission denied"), {
            code: "E_CAPTURE_FAILED" as const
          });
        }
      }
      if (!cameraRef.current) {
        throw Object.assign(new Error("Camera unavailable"), {
          code: "E_CAPTURE_FAILED" as const
        });
      }

      await ensureHardwareKey();

      const status = await getAttestationStatus();
      if (status.isCompromised) {
        throw Object.assign(new Error("Compromised device"), {
          code: "E_COMPROMISED_DEVICE" as const
        });
      }
      if (
        requireTrustedHardware &&
        (status.trustLevel === "software_fallback" || !status.isPhysicalDevice)
      ) {
        throw Object.assign(new Error("Trusted hardware unavailable"), {
          code: "E_NO_TRUSTED_HARDWARE" as const
        });
      }

      triggerFlash();

      const rawPhoto = await cameraRef.current.takePhoto({
        flash: state.flashMode
      });

      const photoPath = rawPhoto.path.startsWith("file://")
        ? rawPhoto.path.slice(7)
        : rawPhoto.path;

      const signedPhoto = await captureAndSignAtomic({
        includeLocation,
        nonce,
        sourcePhotoPath: photoPath,
        appName
      });
      onCapture(signedPhoto);
    } catch (e) {
      onError?.(toCameraError(e));
    } finally {
      capturingRef.current = false;
      setCapturingUI(false);
    }
  }, [
    appName,
    hasPermission,
    includeLocation,
    nonce,
    onCapture,
    onCaptureStart,
    onError,
    requestPermission,
    requireTrustedHardware,
    state.flashMode,
    triggerFlash
  ]);

  // --- Permission screen ---
  if (!hasPermission) {
    return (
      <View style={[styles.container, props.style]}>
        <View style={styles.centeredCard}>
          <Text style={styles.cardTitle}>Camera Access</Text>
          <Text style={styles.cardDescription}>
            This app needs camera access to capture hardware-attested photos
            with embedded C2PA provenance.
          </Text>
          <Pressable
            onPress={requestPermission}
            style={({ pressed }) => [
              styles.permissionButton,
              pressed && styles.buttonPressed
            ]}
          >
            <Text style={styles.permissionButtonText}>Allow Camera</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // --- No device screen ---
  if (!device) {
    return (
      <View style={[styles.container, props.style]}>
        <View style={styles.centeredCard}>
          <Text style={styles.cardTitle}>No Camera</Text>
          <Text style={styles.cardDescription}>
            No camera device is available on this device.
          </Text>
        </View>
      </View>
    );
  }

  // Slider takes precedence over gesture to avoid desync
  const useZoomGesture = enableZoomGesture && !enableZoomSlider;

  // --- Main camera view ---
  return (
    <View
      style={[styles.container, props.style]}
      onTouchEnd={enableFocusTap ? handleTouchEnd : undefined}
    >
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
        zoom={state.zoom}
        torch={state.torch}
        exposure={state.exposure}
        photoQualityBalance={state.photoQuality}
        enableZoomGesture={useZoomGesture}
      />

      {/* Flash overlay */}
      <Animated.View
        style={[styles.flashOverlay, { opacity: flashOpacity }]}
        pointerEvents="none"
      />

      {/* Top bar: flash, torch, camera switch */}
      <TopBar
        flashMode={state.flashMode}
        torch={state.torch}
        hasTorch={device.hasTorch}
        hasFlash={device.hasFlash}
        showFlashButton={enableFlashMode}
        showTorchButton={enableTorch}
        showCameraSwitch={enableCameraSwitch}
        onCycleFlash={actions.cycleFlashMode}
        onToggleTorch={actions.toggleTorch}
        onToggleCamera={toggleCameraPosition}
        safeAreaTop={safeAreaTop}
      />

      {/* Zoom slider */}
      {enableZoomSlider && (
        <ZoomSlider
          zoom={state.zoom}
          device={device}
          onChange={actions.setZoom}
          safeAreaTop={safeAreaTop}
        />
      )}

      {/* Exposure slider */}
      {enableExposureSlider && (
        <ExposureSlider
          exposure={state.exposure}
          device={device}
          onChange={actions.setExposure}
          safeAreaTop={safeAreaTop}
        />
      )}

      {/* Focus indicator */}
      {enableFocusTap && state.focusPoint && (
        <FocusIndicator
          point={state.focusPoint}
          onAnimationDone={actions.clearFocusPoint}
        />
      )}

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        {capturingUI ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.signingText}>Signing...</Text>
          </View>
        ) : (
          <View style={styles.bottomRow}>
            {enableQualitySelector ? (
              <QualitySelector
                quality={state.photoQuality}
                onCycle={actions.cyclePhotoQuality}
              />
            ) : (
              <View style={styles.bottomSpacer} />
            )}
            <Pressable
              onPress={onPressCapture}
              style={({ pressed }) => [
                styles.shutterOuter,
                pressed && styles.shutterPressed
              ]}
            >
              <View style={styles.shutterInner} />
            </Pressable>
            <View style={styles.bottomSpacer} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000"
  },
  // --- Flash ---
  flashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#fff"
  },
  // --- Bottom bar ---
  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
    alignItems: "center",
    justifyContent: "center"
  },
  bottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    paddingHorizontal: 24,
    gap: 24
  },
  bottomSpacer: {
    width: 52
  },
  // --- Shutter button ---
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center"
  },
  shutterPressed: {
    opacity: 0.6
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: "#fff"
  },
  // --- Loading state ---
  loadingContainer: {
    alignItems: "center"
  },
  signingText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 8
  },
  // --- Permission / No device ---
  centeredCard: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 12
  },
  cardDescription: {
    fontSize: 15,
    color: "#aaa",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 24
  },
  permissionButton: {
    backgroundColor: "#6200ee",
    paddingVertical: 14,
    paddingHorizontal: 36,
    borderRadius: 28
  },
  buttonPressed: {
    opacity: 0.7
  },
  permissionButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600"
  }
});
