import React, {useCallback, useEffect} from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
} from 'react-native';
import {AttestedCamera} from './src/AttestedCamera';
import type {AttestedCameraError} from './src/types';
import type {SignedPhoto} from '@rolobits/attestation-photo-mobile';
import {saveToGallery} from '@rolobits/attestation-photo-mobile';

export default function App() {
  useEffect(() => {
    if (Platform.OS === 'android') {
      const perms: Array<(typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS]> = [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ];
      // Pre-Q devices need WRITE_EXTERNAL_STORAGE for direct file saves;
      // API 29+ uses MediaStore which doesn't require this permission.
      if (Number(Platform.Version) < 29) {
        perms.push(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
      }
      PermissionsAndroid.requestMultiple(perms).catch(() => {});
    }
  }, []);

  const handleCapture = useCallback((photo: SignedPhoto) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    saveToGallery({
      filePath: photo.path,
      fileName: `attested_${timestamp}.jpg`,
    }).catch((e: any) => {
      Alert.alert('Save Failed', e?.message ?? 'Unknown error');
    });
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <AttestedCamera
        style={styles.camera}
        requireTrustedHardware={false}
        includeLocation={true}
        enableZoomSlider
        enableFocusTap
        enableTorch
        enableFlashMode
        enableCameraSwitch
        enableExposureSlider
        enableQualitySelector
        onCapture={handleCapture}
        onError={(error: AttestedCameraError) => {
          Alert.alert('Capture Error', `${error.code}\n${error.message}`);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  camera: {
    flex: 1,
  },
});
