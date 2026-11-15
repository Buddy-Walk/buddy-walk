import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Image } from 'react-native-nitro-image';
import {
  Camera,
  HybridFrameConverter,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
  type Frame,
} from 'react-native-vision-camera';
import { useTextRecognition, type TextRecognitionOptions } from 'react-native-vision-camera-ocr-plus';
import { createSynchronizable, scheduleOnRN } from 'react-native-worklets';

import type { FrameReadings, Size } from './Reading';
import { toReadings, uprightSize } from './toReadings';

/** A frame as an image, with the Readings of that same frame. */
export type Snapshot = { image: Image; frame: FrameReadings };

export type ReadingsCameraRef = {
  /** Captures the next processed frame and its Readings. */
  takeSnapshot(): Promise<Snapshot>;
};

type Props = {
  isActive: boolean;
  /** Called on the JS thread for every processed frame, including frames with no Readings. */
  onFrameReadings: (frame: FrameReadings) => void;
  /** Drawn over the camera view, in a box that matches the frame, so `Box` fractions can be used as percentages. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  ref?: Ref<ReadingsCameraRef>;
};

// Every frame the camera delivers is read. With the Buddy Walk patch, ocr-plus reads frames
// synchronously, and VisionCamera drops frames that arrive while one is being read.
const recognitionOptions: TextRecognitionOptions = { language: 'latin', frameSkipThreshold: 1 };

const SNAPSHOT_TIMEOUT_MS = 3000;

// Frames are 16:9 landscape buffers, so upright they are 9:16 until the first frame says otherwise.
const defaultFrameSize = { width: 720, height: 1280 };

/**
 * The back camera, reading text live on the phone with Google ML Kit.
 * It knows nothing about sessions or Marks, so later screens can use it as it is.
 */
export function ReadingsCamera({ isActive, onFrameReadings, children, style, ref }: Props) {
  const permission = useCameraPermission();
  const device = useCameraDevice('back');
  const { recognizer } = useTextRecognition(recognitionOptions);
  const [frameSize, setFrameSize] = useState(defaultFrameSize);
  const [containerSize, setContainerSize] = useState<Size | null>(null);

  const { canRequestPermission, requestPermission } = permission;
  useEffect(() => {
    if (canRequestPermission) requestPermission();
  }, [canRequestPermission, requestPermission]);

  const onFrameReadingsRef = useRef(onFrameReadings);
  onFrameReadingsRef.current = onFrameReadings;
  const deliver = useCallback((frame: FrameReadings) => {
    setFrameSize((current) =>
      current.width === frame.frameSize.width && current.height === frame.frameSize.height ? current : frame.frameSize,
    );
    onFrameReadingsRef.current(frame);
  }, []);

  const snapshotRequested = useMemo(() => createSynchronizable(false), []);
  const pendingSnapshot = useRef<{ resolve: (snapshot: Snapshot) => void; promise: Promise<Snapshot> } | null>(null);
  const deliverSnapshot = useCallback((image: Image, frame: FrameReadings) => {
    pendingSnapshot.current?.resolve({ image, frame });
    pendingSnapshot.current = null;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      takeSnapshot() {
        if (pendingSnapshot.current) return pendingSnapshot.current.promise;
        let resolve!: (snapshot: Snapshot) => void;
        const promise = new Promise<Snapshot>((resolvePromise, reject) => {
          resolve = resolvePromise;
          setTimeout(() => {
            if (pendingSnapshot.current?.promise !== promise) return;
            pendingSnapshot.current = null;
            snapshotRequested.setBlocking(false);
            reject(new Error('The camera did not deliver a frame'));
          }, SNAPSHOT_TIMEOUT_MS);
        });
        pendingSnapshot.current = { resolve, promise };
        snapshotRequested.setBlocking(true);
        return promise;
      },
    }),
    [snapshotRequested],
  );

  const onFrame = useCallback(
    (frame: Frame) => {
      'worklet';
      try {
        const started = Date.now();
        const buffer = frame.getNativeBuffer();
        let recognized;
        try {
          recognized = recognizer.scanFrame(buffer.pointer, frame.orientation);
        } finally {
          buffer.release();
        }
        const recognitionMs = Date.now() - started;
        // Undefined means ocr-plus could not read this frame at all, which is not the same as reading no text.
        if (recognized === undefined) return;

        const info = { width: frame.width, height: frame.height, orientation: frame.orientation, timestamp: frame.timestamp };
        const frameReadings: FrameReadings = {
          readings: toReadings(recognized, info, recognitionMs),
          frameSize: uprightSize(info),
        };
        if (snapshotRequested.getDirty()) {
          snapshotRequested.setBlocking(false);
          scheduleOnRN(deliverSnapshot, HybridFrameConverter.convertFrameToImage(frame), frameReadings);
        }
        scheduleOnRN(deliver, frameReadings);
      } catch {
        // ML Kit failed on this frame. The frame is skipped, as if it had been dropped.
      } finally {
        frame.dispose();
      }
    },
    [recognizer, snapshotRequested, deliver, deliverSnapshot],
  );

  const frameOutput = useFrameOutput({
    pixelFormat: 'yuv',
    onFrame,
    // Dropped frames are expected: they arrive while the previous frame is still being read.
    onFrameDropped: ignoreDroppedFrame,
  });
  const outputs = useMemo(() => [frameOutput], [frameOutput]);

  if (!permission.hasPermission) {
    return (
      <View style={[styles.message, style]}>
        <Text style={styles.messageText}>
          {permission.canRequestPermission
            ? 'Waiting for camera permission.'
            : 'BW Live needs the camera to read signs and door numbers. Turn on Camera for BW Live in Settings.'}
        </Text>
        {!permission.canRequestPermission && (
          <Pressable accessibilityRole="button" onPress={() => Linking.openSettings()} style={styles.settingsButton}>
            <Text style={styles.settingsButtonText}>Open Settings</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (device === undefined) {
    return (
      <View style={[styles.message, style]}>
        <Text style={styles.messageText}>This phone has no back camera.</Text>
      </View>
    );
  }

  return (
    <View
      style={[styles.container, style]}
      onLayout={(event) => setContainerSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
    >
      {containerSize && (
        <View style={containedSize(frameSize, containerSize)}>
          <Camera style={StyleSheet.absoluteFill} device={device} isActive={isActive} outputs={outputs} resizeMode="contain" />
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {children}
          </View>
        </View>
      )}
    </View>
  );
}

function ignoreDroppedFrame() {}

/** The largest size with the frame's aspect ratio that fits in the container. */
function containedSize(frame: Size, container: Size): Size {
  const scale = Math.min(container.width / frame.width, container.height / frame.height);
  return { width: frame.width * scale, height: frame.height * scale };
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  message: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#000',
  },
  messageText: {
    color: '#fff',
    fontSize: 18,
    textAlign: 'center',
  },
  settingsButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#fff',
  },
  settingsButtonText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '600',
  },
});
