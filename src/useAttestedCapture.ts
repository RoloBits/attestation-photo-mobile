import { useCallback, useEffect, useRef, useState } from "react";
import {
  captureAndSignAtomic,
  ensureHardwareKey,
  getAttestationStatus,
  prefetchLocation
} from "./nativeBridge";
import type {
  AttestationStatus,
  AttestedCameraError,
  SignedPhoto
} from "./types";

export interface UseAttestedCaptureOptions {
  includeLocation?: boolean;
  requireTrustedHardware?: boolean;
  appName?: string;
  nonce?: string;
}

export interface UseAttestedCaptureResult {
  /** Sign a photo at the given path. Strips file:// prefix automatically.
      Rejects with AttestedCameraError on trust/signing failures. */
  signPhoto: (photoPath: string) => Promise<SignedPhoto>;
  /** Current attestation status (null while loading on mount) */
  status: AttestationStatus | null;
  /** True once key provisioning + status check have completed */
  isReady: boolean;
}

function toAttestedError(err: unknown): AttestedCameraError {
  const base = err instanceof Error ? err : new Error(String(err));
  const code =
    typeof err === "object" &&
    err &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
      ? ((err as { code: AttestedCameraError["code"] }).code ??
        "E_CAPTURE_FAILED")
      : "E_CAPTURE_FAILED";
  return Object.assign(base, { code }) as AttestedCameraError;
}

export function useAttestedCapture(
  options: UseAttestedCaptureOptions = {}
): UseAttestedCaptureResult {
  const {
    includeLocation = false,
    requireTrustedHardware = true,
    appName,
    nonce
  } = options;

  const [status, setStatus] = useState<AttestationStatus | null>(null);
  const [isReady, setIsReady] = useState(false);
  const statusRef = useRef<AttestationStatus | null>(null);
  const locationRef = useRef<{ latitude: number; longitude: number } | null>(
    null
  );

  // Parallel init: attestation status + key provisioning
  useEffect(() => {
    let cancelled = false;
    Promise.all([getAttestationStatus(), ensureHardwareKey()])
      .then(([s]) => {
        if (cancelled) return;
        statusRef.current = s;
        setStatus(s);
        setIsReady(true);
      })
      .catch(() => {
        if (!cancelled) setIsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Location prefetch
  useEffect(() => {
    if (!includeLocation) return;
    let cancelled = false;
    prefetchLocation()
      .then((loc) => {
        if (!cancelled && loc) locationRef.current = loc;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [includeLocation]);

  const signPhoto = useCallback(
    async (photoPath: string): Promise<SignedPhoto> => {
      try {
        // Strip file:// prefix (VisionCamera quirk)
        const cleanPath = photoPath.startsWith("file://")
          ? photoPath.slice(7)
          : photoPath;

        // Trust checks (cache fallback so subsequent calls don't re-fetch)
        let s = statusRef.current;
        if (!s) {
          s = await getAttestationStatus();
          statusRef.current = s;
          setStatus(s);
        }
        if (s.isCompromised) {
          throw Object.assign(new Error("Compromised device"), {
            code: "E_COMPROMISED_DEVICE" as const
          });
        }
        if (
          requireTrustedHardware &&
          (s.trustLevel === "software_fallback" || !s.isPhysicalDevice)
        ) {
          throw Object.assign(new Error("Trusted hardware unavailable"), {
            code: "E_NO_TRUSTED_HARDWARE" as const
          });
        }

        const loc = locationRef.current;
        const result = await captureAndSignAtomic({
          sourcePhotoPath: cleanPath,
          includeLocation,
          nonce,
          appName,
          ...(loc && { latitude: loc.latitude, longitude: loc.longitude })
        });

        // Re-prefetch location for next shot
        if (includeLocation) {
          prefetchLocation()
            .then((newLoc) => {
              if (newLoc) locationRef.current = newLoc;
            })
            .catch(() => {});
        }

        return result;
      } catch (e) {
        throw toAttestedError(e);
      }
    },
    [appName, includeLocation, nonce, requireTrustedHardware]
  );

  return { signPhoto, status, isReady };
}
