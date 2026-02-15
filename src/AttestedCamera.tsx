import React, { useCallback, useRef } from "react";
import { Pressable, Text, View } from "react-native";
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
    includeLocation = false,
    nonce,
    requireTrustedHardware = true,
    cameraPosition = "back"
  } = props;
  const cameraRef = useRef<Camera>(null);
  const busyRef = useRef(false);
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice(cameraPosition);

  const onPressCapture = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
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
      await native.ensureHardwareKey();
      const status = await native.getAttestationStatus();
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

      const rawPhoto = await cameraRef.current.takePhoto();
      const signedPhoto = await native.captureAndSignAtomic({
        includeLocation,
        nonce,
        sourcePhotoPath: rawPhoto.path
      });
      // Integrity is now guaranteed by the embedded C2PA manifest (JUMBF).
      // The file on disk is the signed JPEG; its hash differs from the
      // original unsigned bytes, so a separate hash check is not applicable.
      onCapture(signedPhoto);
    } catch (e) {
      onError?.(toCameraError(e));
    } finally {
      busyRef.current = false;
    }
  }, [
    hasPermission,
    includeLocation,
    nonce,
    onCapture,
    onError,
    requestPermission,
    requireTrustedHardware
  ]);

  if (!hasPermission) {
    return (
      <View style={props.style}>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 12, borderRadius: 8, alignSelf: "center" }}
        >
          <Text>Grant Camera Permission</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={props.style}>
        <Text>No camera device available.</Text>
      </View>
    );
  }

  return (
    <View style={props.style}>
      <Camera
        ref={cameraRef}
        style={{ flex: 1 }}
        device={device}
        isActive
        photo
      />
      <Pressable
        onPress={onPressCapture}
        style={{ padding: 12, borderRadius: 8, alignSelf: "center" }}
      >
        <Text>Capture (Attested)</Text>
      </Pressable>
    </View>
  );
}
