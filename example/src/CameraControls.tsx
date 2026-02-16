import React, { useCallback, useEffect, useRef } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { CameraDevice } from "react-native-vision-camera";
import type { FlashMode, PhotoQuality } from "./types";
import type { FocusPoint } from "./useCameraControls";

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

interface TopBarProps {
  flashMode: FlashMode;
  torch: "off" | "on";
  hasTorch: boolean;
  hasFlash: boolean;
  showFlashButton: boolean;
  showTorchButton: boolean;
  showCameraSwitch: boolean;
  onCycleFlash: () => void;
  onToggleTorch: () => void;
  onToggleCamera: () => void;
  safeAreaTop: number;
}

const FLASH_LABELS: Record<FlashMode, string> = {
  off: "F.OFF",
  on: "F.ON",
  auto: "F.AUTO",
};

export function TopBar(props: TopBarProps) {
  const {
    flashMode,
    torch,
    hasTorch,
    hasFlash,
    showFlashButton,
    showTorchButton,
    showCameraSwitch,
    onCycleFlash,
    onToggleTorch,
    onToggleCamera,
    safeAreaTop,
  } = props;

  const anyVisible =
    (showFlashButton && hasFlash) ||
    (showTorchButton && hasTorch) ||
    showCameraSwitch;

  if (!anyVisible) return null;

  return (
    <View style={[topBarStyles.container, { paddingTop: safeAreaTop + 8 }]}>
      <View style={topBarStyles.left}>
        {showFlashButton && hasFlash && (
          <Pressable
            onPress={onCycleFlash}
            style={({ pressed }) => [
              topBarStyles.button,
              pressed && topBarStyles.pressed,
            ]}
          >
            <Text style={topBarStyles.text}>{FLASH_LABELS[flashMode]}</Text>
          </Pressable>
        )}
        {showTorchButton && hasTorch && (
          <Pressable
            onPress={onToggleTorch}
            style={({ pressed }) => [
              topBarStyles.button,
              torch === "on" && topBarStyles.active,
              pressed && topBarStyles.pressed,
            ]}
          >
            <Text style={topBarStyles.text}>TORCH</Text>
          </Pressable>
        )}
      </View>
      <View style={topBarStyles.right}>
        {showCameraSwitch && (
          <Pressable
            onPress={onToggleCamera}
            style={({ pressed }) => [
              topBarStyles.button,
              pressed && topBarStyles.pressed,
            ]}
          >
            <Text style={topBarStyles.text}>FLIP</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const topBarStyles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    zIndex: 10,
  },
  left: {
    flexDirection: "row",
    gap: 8,
  },
  right: {
    flexDirection: "row",
    gap: 8,
  },
  button: {
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  active: {
    backgroundColor: "rgba(255,204,0,0.7)",
  },
  pressed: {
    opacity: 0.6,
  },
  text: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
});

// ---------------------------------------------------------------------------
// VerticalSlider (shared by zoom and exposure)
// ---------------------------------------------------------------------------

const TRACK_HEIGHT = 200;
const THUMB_SIZE = 36;

interface VerticalSliderProps {
  value: number;
  min: number;
  max: number;
  topLabel: string;
  bottomLabel: string;
  formatValue: (v: number) => string;
  logarithmic?: boolean;
  onChange: (value: number) => void;
  style?: object;
}

function VerticalSlider(props: VerticalSliderProps) {
  const {
    value,
    min,
    max,
    topLabel,
    bottomLabel,
    formatValue,
    logarithmic = false,
    onChange,
    style,
  } = props;

  const valueToFraction = useCallback(
    (v: number) => {
      if (max === min) return 0;
      if (logarithmic && min > 0) {
        return (
          (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min))
        );
      }
      return (v - min) / (max - min);
    },
    [min, max, logarithmic]
  );

  const fractionToValue = useCallback(
    (f: number) => {
      const clamped = Math.min(Math.max(f, 0), 1);
      if (logarithmic && min > 0) {
        return Math.exp(
          Math.log(min) + clamped * (Math.log(max) - Math.log(min))
        );
      }
      return min + clamped * (max - min);
    },
    [min, max, logarithmic]
  );

  // fraction: 0 = bottom (min), 1 = top (max)
  const fraction = valueToFraction(value);
  // In screen coords: top of track = max, bottom = min
  const thumbTop = (1 - fraction) * (TRACK_HEIGHT - THUMB_SIZE);

  const startFraction = useRef(fraction);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startFraction.current = valueToFraction(value);
      },
      onPanResponderMove: (_evt, gestureState) => {
        // dy negative = drag up = increase
        const deltaFraction = -gestureState.dy / (TRACK_HEIGHT - THUMB_SIZE);
        const newFraction = startFraction.current + deltaFraction;
        onChange(fractionToValue(newFraction));
      },
    })
  ).current;

  return (
    <View style={[sliderStyles.container, style]}>
      <Text style={sliderStyles.label}>{topLabel}</Text>
      <View style={sliderStyles.track} {...panResponder.panHandlers}>
        <View style={sliderStyles.trackLine} />
        <View style={[sliderStyles.thumb, { top: thumbTop }]}>
          <Text style={sliderStyles.thumbText}>{formatValue(value)}</Text>
        </View>
      </View>
      <Text style={sliderStyles.label}>{bottomLabel}</Text>
    </View>
  );
}

const sliderStyles = StyleSheet.create({
  container: {
    alignItems: "center",
    width: 52,
  },
  track: {
    height: TRACK_HEIGHT,
    width: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  trackLine: {
    position: "absolute",
    width: 2,
    height: TRACK_HEIGHT - THUMB_SIZE,
    top: THUMB_SIZE / 2,
    backgroundColor: "rgba(255,255,255,0.3)",
    borderRadius: 1,
  },
  thumb: {
    position: "absolute",
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 2,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "700",
  },
  label: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 10,
    fontWeight: "600",
    marginVertical: 4,
  },
});

// ---------------------------------------------------------------------------
// ZoomSlider
// ---------------------------------------------------------------------------

interface ZoomSliderProps {
  zoom: number;
  device: CameraDevice;
  onChange: (zoom: number) => void;
  safeAreaTop: number;
}

export function ZoomSlider({ zoom, device, onChange, safeAreaTop }: ZoomSliderProps) {
  return (
    <VerticalSlider
      value={zoom}
      min={device.minZoom}
      max={device.maxZoom}
      topLabel={`${device.maxZoom.toFixed(0)}x`}
      bottomLabel={`${device.minZoom.toFixed(0)}x`}
      formatValue={(v) => `${v.toFixed(1)}x`}
      logarithmic
      onChange={onChange}
      style={[rightSliderStyles.zoom, { top: safeAreaTop + 50 }]}
    />
  );
}

// ---------------------------------------------------------------------------
// ExposureSlider
// ---------------------------------------------------------------------------

interface ExposureSliderProps {
  exposure: number;
  device: CameraDevice;
  onChange: (exposure: number) => void;
  safeAreaTop: number;
}

export function ExposureSlider({
  exposure,
  device,
  onChange,
  safeAreaTop,
}: ExposureSliderProps) {
  if (device.minExposure === 0 && device.maxExposure === 0) return null;
  return (
    <VerticalSlider
      value={exposure}
      min={device.minExposure}
      max={device.maxExposure}
      topLabel={`+${device.maxExposure}EV`}
      bottomLabel={`${device.minExposure}EV`}
      formatValue={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`}
      onChange={onChange}
      style={rightSliderStyles.exposure}
    />
  );
}

const rightSliderStyles = StyleSheet.create({
  zoom: {
    position: "absolute",
    right: 4,
    zIndex: 10,
  },
  exposure: {
    position: "absolute",
    right: 4,
    bottom: 150,
    zIndex: 10,
  },
});

// ---------------------------------------------------------------------------
// FocusIndicator
// ---------------------------------------------------------------------------

interface FocusIndicatorProps {
  point: FocusPoint;
  onAnimationDone: () => void;
}

export function FocusIndicator({ point, onAnimationDone }: FocusIndicatorProps) {
  const scale = useRef(new Animated.Value(1.5)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    scale.setValue(1.5);
    opacity.setValue(1);
    Animated.sequence([
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        speed: 20,
        bounciness: 4,
      }),
      Animated.delay(600),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => onAnimationDone());
  }, [point.key, scale, opacity, onAnimationDone]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        focusStyles.reticle,
        {
          left: point.x - 30,
          top: point.y - 30,
          transform: [{ scale }],
          opacity,
        },
      ]}
    />
  );
}

const focusStyles = StyleSheet.create({
  reticle: {
    position: "absolute",
    width: 60,
    height: 60,
    borderWidth: 2,
    borderColor: "#ffcc00",
    borderRadius: 4,
    zIndex: 20,
  },
});

// ---------------------------------------------------------------------------
// QualitySelector
// ---------------------------------------------------------------------------

const QUALITY_LABELS: Record<PhotoQuality, string> = {
  speed: "SPD",
  balanced: "BAL",
  quality: "HQ",
};

interface QualitySelectorProps {
  quality: PhotoQuality;
  onCycle: () => void;
}

export function QualitySelector({ quality, onCycle }: QualitySelectorProps) {
  return (
    <Pressable
      onPress={onCycle}
      style={({ pressed }) => [
        qualityStyles.button,
        pressed && qualityStyles.pressed,
      ]}
    >
      <Text style={qualityStyles.text}>{QUALITY_LABELS[quality]}</Text>
    </Pressable>
  );
}

const qualityStyles = StyleSheet.create({
  button: {
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  pressed: {
    opacity: 0.6,
  },
  text: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
});
