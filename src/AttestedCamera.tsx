import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View
} from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission
} from "react-native-vision-camera";
import { requireNativeModule } from "./nativeBridge";
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
    onLog,
    includeLocation = false,
    nonce,
    requireTrustedHardware = true,
    cameraPosition = "back",
    showFlash = true,
    appName
  } = props;
  const cameraRef = useRef<Camera>(null);
  const [capturingUI, setCapturingUI] = useState(false);
  const capturingRef = useRef(false);
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice(cameraPosition);

  const triggerFlash = useCallback(() => {
    if (!showFlash) return;
    flashOpacity.setValue(1);
    Animated.timing(flashOpacity, {
      toValue: 0,
      duration: 300,
      useNativeDriver: true
    }).start();
  }, [flashOpacity, showFlash]);

  const onPressCapture = useCallback(async () => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    setCapturingUI(true);
    onCaptureStart?.();
    const log = (msg: string) => { console.log(msg); onLog?.(msg); };
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

      const native = requireNativeModule();

      log("[AttestedCamera] step 1: ensureHardwareKey...");
      await native.ensureHardwareKey();

      log("[AttestedCamera] step 2: getAttestationStatus...");
      const status = await native.getAttestationStatus();
      log(`[AttestedCamera] step 2: status = ${JSON.stringify(status)}`);
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

      log("[AttestedCamera] step 3: takePhoto...");
      const rawPhoto = await cameraRef.current.takePhoto();
      log(`[AttestedCamera] step 3: rawPhoto.path = ${rawPhoto.path}`);

      const photoPath = rawPhoto.path.startsWith("file://")
        ? rawPhoto.path.slice(7)
        : rawPhoto.path;

      log("[AttestedCamera] step 4: captureAndSignAtomic...");
      const signedPhoto = await native.captureAndSignAtomic({
        includeLocation,
        nonce,
        sourcePhotoPath: photoPath,
        appName
      });
      log("[AttestedCamera] step 5: done, calling onCapture");
      onCapture(signedPhoto);
    } catch (e) {
      const cameraError = toCameraError(e);
      const stack = (e as Error)?.stack ?? "";
      log(`[AttestedCamera] capture failed: ${cameraError.code} ${cameraError.message}\n${stack}`);
      onError?.(cameraError);
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
    onLog,
    requestPermission,
    requireTrustedHardware,
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

  // --- Main camera view ---
  return (
    <View style={[styles.container, props.style]}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
      />

      {/* Top gradient overlay */}
      <View style={styles.topGradient} pointerEvents="none" />

      {/* Bottom gradient overlay */}
      <View style={styles.bottomGradient} pointerEvents="none" />

      {/* Flash overlay */}
      <Animated.View
        style={[styles.flashOverlay, { opacity: flashOpacity }]}
        pointerEvents="none"
      />

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        {capturingUI ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
            <Text style={styles.signingText}>Signing...</Text>
          </View>
        ) : (
          <Pressable
            onPress={onPressCapture}
            style={({ pressed }) => [
              styles.shutterOuter,
              pressed && styles.shutterPressed
            ]}
          >
            <View style={styles.shutterInner} />
          </Pressable>
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
  // --- Gradient overlays ---
  topGradient: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    backgroundColor: "rgba(0,0,0,0.4)"
  },
  bottomGradient: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 160,
    backgroundColor: "rgba(0,0,0,0.5)"
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
