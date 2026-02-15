import React, {useState, useCallback, useEffect, useRef} from 'react';
import {
  Alert,
  FlatList,
  Image,
  NativeModules,
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
import {AttestedCamera} from '@RoloBits/attestation-photo-mobile';
import type {
  SignedPhoto,
  AttestedCameraError,
} from '@RoloBits/attestation-photo-mobile';

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

type LogEntry = {id: string; time: string; msg: string; isError: boolean};

export default function App() {
  const [state, setState] = useState<AppState>({kind: 'camera'});
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logListRef = useRef<FlatList<LogEntry>>(null);
  const logIdRef = useRef(0);

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

  const addLog = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString('en-US', {hour12: false, fractionalSecondDigits: 3});
    const id = String(++logIdRef.current);
    const isError = msg.includes('ERROR') || msg.includes('failed');
    setLogs(prev => [...prev, {id, time, msg, isError}]);
  }, []);

  const handleSaveToGallery = useCallback(async (photoPath: string) => {
    if (saving || saved) return;
    setSaving(true);
    try {
      // Request WRITE_EXTERNAL_STORAGE on pre-Q Android (API 28)
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

      const native = NativeModules.RNAttestationMobile;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await native.saveToGallery({
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
          {/* Photo preview */}
          <View style={styles.previewContainer}>
            <Image
              source={{uri: photoUri}}
              style={styles.previewImage}
              resizeMode="cover"
            />
          </View>

          {/* Attestation summary card */}
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

          {/* Action buttons */}
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

          {/* Expandable details */}
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

          {/* Take another */}
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
      {/* Top half: camera */}
      <View style={styles.cameraHalf}>
        <AttestedCamera
          style={styles.camera}
          requireTrustedHardware={false}
          includeLocation={true}
          onLog={addLog}
          onCapture={(photo: SignedPhoto) => {
            addLog(`[App] Capture complete: ${photo.path}`);
            setState({kind: 'result', photo});
          }}
          onError={(error: AttestedCameraError) => {
            addLog(`[App] ERROR: ${error.code} — ${error.message}`);
            Alert.alert('Capture Error', `${error.code}\n${error.message}`);
          }}
        />
      </View>
      {/* Bottom half: log panel */}
      <View style={styles.logPanel}>
        <View style={styles.logHeader}>
          <Text style={styles.logHeaderText}>Debug Log</Text>
          <Pressable onPress={() => setLogs([])} style={styles.clearButton}>
            <Text style={styles.clearButtonText}>Clear</Text>
          </Pressable>
        </View>
        <FlatList
          ref={logListRef}
          data={logs}
          keyExtractor={item => item.id}
          style={styles.logList}
          onContentSizeChange={() => logListRef.current?.scrollToEnd({animated: true})}
          renderItem={({item}) => (
            <Text style={item.isError ? styles.logLineError : styles.logLine} selectable>
              <Text style={styles.logTime}>{item.time}</Text>
              {'  '}
              {item.msg}
            </Text>
          )}
          ListEmptyComponent={
            <Text style={styles.logEmpty}>Waiting for capture...</Text>
          }
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#121212',
  },
  cameraHalf: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  // --- Log panel ---
  logPanel: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#1a1a1a',
  },
  logHeaderText: {
    color: '#888',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: '#333',
  },
  clearButtonText: {
    color: '#aaa',
    fontSize: 11,
    fontWeight: '600',
  },
  logList: {
    flex: 1,
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  logLine: {
    color: '#39ff14',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
    paddingVertical: 1,
  },
  logLineError: {
    color: '#ff5252',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
    paddingVertical: 1,
  },
  logTime: {
    color: '#666',
  },
  logEmpty: {
    color: '#555',
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginTop: 20,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 48,
  },
  // --- Photo preview ---
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
  // --- Summary card ---
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
  // --- Action buttons ---
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
  // --- Details toggle ---
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
  // --- Detail rows ---
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
  // --- Buttons ---
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
