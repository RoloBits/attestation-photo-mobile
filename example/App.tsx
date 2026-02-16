import React, {useState, useCallback, useEffect} from 'react';
import {
  Alert,
  Image,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {AttestedCamera} from './src/AttestedCamera';
import type {AttestedCameraError} from './src/types';
import type {SignedPhoto} from '@rolobits/attestation-photo-mobile';
import {saveToGallery} from '@rolobits/attestation-photo-mobile';

type AppState =
  | {kind: 'camera'}
  | {kind: 'result'; photo: SignedPhoto};

function trustBadge(level: string): {label: string; color: string} {
  switch (level) {
    case 'secure_enclave':
    case 'strongbox':
      return {label: 'Hardware Attested', color: '#4caf50'};
    case 'tee':
      return {label: 'TEE Attested', color: '#8bc34a'};
    default:
      return {label: 'Software Signed', color: '#ff9800'};
  }
}

export default function App() {
  const [state, setState] = useState<AppState>({kind: 'camera'});
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'android') {
      PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location Permission',
          message: 'This app embeds GPS coordinates in attested photos for content provenance.',
          buttonPositive: 'Allow',
        },
      ).catch(() => {});
    }
  }, []);

  const handleSaveToGallery = useCallback(async (photoPath: string) => {
    if (saving || saved) return;
    setSaving(true);
    try {
      if (Platform.OS === 'android' && (Platform.Version as number) < 29) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
          {
            title: 'Storage Permission',
            message: 'This app needs access to save photos to your gallery.',
            buttonPositive: 'Allow',
          },
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Permission Denied', 'Cannot save without storage permission.');
          return;
        }
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await saveToGallery({
        filePath: photoPath,
        fileName: `attested_${timestamp}.jpg`,
      });
      setSaved(true);
      Alert.alert('Saved', 'Photo saved to Pictures/Attestation folder.');
    } catch (e: any) {
      Alert.alert('Save Failed', e?.message ?? 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [saving, saved]);

  if (state.kind === 'result') {
    const {photo} = state;
    const badge = trustBadge(photo.trustLevel);
    const photoUri =
      Platform.OS === 'android'
        ? `file://${photo.path}`
        : photo.path;

    const loc = photo.metadata.location;
    const detailRows: [string, string][] = [
      ['Path', photo.path],
      ['Algorithm', photo.algorithm],
      ['Manifest Format', photo.manifestFormat],
      ['Embedded Manifest', String(photo.embeddedManifest ?? false)],
      ['Signature (first 40)', photo.signature.slice(0, 40) + '...'],
      ['Device', photo.metadata.deviceModel],
      ['OS', photo.metadata.osVersion],
      ['SHA-256', photo.metadata.sourceSha256 ?? 'N/A'],
      ['Pipeline', photo.metadata.pipelineMode ?? 'N/A'],
      ...(loc
        ? [['GPS', `${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}`] as [string, string]]
        : []),
    ];

    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" />
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.previewContainer}>
            <Image
              source={{uri: photoUri}}
              style={styles.previewImage}
              resizeMode="cover"
            />
          </View>

          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <View style={[styles.badge, {backgroundColor: badge.color}]}>
                <Text style={styles.badgeText}>{badge.label}</Text>
              </View>
              <Text style={styles.trustLevel}>{photo.trustLevel}</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Captured</Text>
              <Text style={styles.summaryValue}>
                {new Date(photo.metadata.capturedAtIso8601).toLocaleString()}
              </Text>
            </View>
            {photo.embeddedManifest && (
              <>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>C2PA</Text>
                  <Text style={[styles.summaryValue, {color: '#4caf50'}]}>
                    JUMBF Embedded
                  </Text>
                </View>
              </>
            )}
          </View>

          <View style={styles.actionRow}>
            <Pressable
              style={({pressed}) => [
                styles.saveButton,
                saved && styles.saveButtonDone,
                pressed && styles.buttonPressed,
              ]}
              onPress={() => handleSaveToGallery(photo.path)}
              disabled={saving || saved}>
              <Text style={styles.buttonText}>
                {saved ? 'Saved' : saving ? 'Saving...' : 'Save to Gallery'}
              </Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() => setDetailsExpanded(prev => !prev)}
            style={styles.detailsToggle}>
            <Text style={styles.detailsToggleText}>
              {detailsExpanded ? 'Hide Details' : 'Show Details'}
            </Text>
          </Pressable>

          {detailsExpanded &&
            detailRows.map(([label, value]) => (
              <View key={label} style={styles.row}>
                <Text style={styles.label}>{label}</Text>
                <Text style={styles.value} selectable>
                  {value}
                </Text>
              </View>
            ))}

          <Pressable
            style={({pressed}) => [styles.button, pressed && styles.buttonPressed]}
            onPress={() => {
              setDetailsExpanded(false);
              setSaved(false);
              setState({kind: 'camera'});
            }}>
            <Text style={styles.buttonText}>Take Another</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

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
        onCapture={(photo: SignedPhoto) => {
          setState({kind: 'result', photo});
        }}
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
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
  },
  previewContainer: {
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 16,
    backgroundColor: '#1e1e1e',
  },
  previewImage: {
    width: '100%',
    aspectRatio: 3 / 4,
  },
  summaryCard: {
    backgroundColor: '#1e1e1e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryDivider: {
    height: 1,
    backgroundColor: '#333',
    marginVertical: 12,
  },
  summaryLabel: {
    fontSize: 14,
    color: '#888',
  },
  summaryValue: {
    fontSize: 14,
    color: '#fff',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  trustLevel: {
    fontSize: 13,
    color: '#888',
    fontFamily: 'monospace',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 4,
  },
  saveButton: {
    backgroundColor: '#2196f3',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 28,
  },
  saveButtonDone: {
    backgroundColor: '#4caf50',
  },
  detailsToggle: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  detailsToggleText: {
    color: '#6200ee',
    fontSize: 14,
    fontWeight: '600',
  },
  row: {
    marginBottom: 8,
    backgroundColor: '#1e1e1e',
    borderRadius: 8,
    padding: 12,
  },
  label: {
    fontSize: 11,
    color: '#888',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  value: {
    fontSize: 13,
    color: '#fff',
  },
  button: {
    marginTop: 16,
    backgroundColor: '#6200ee',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 28,
    alignSelf: 'center',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
