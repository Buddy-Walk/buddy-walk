export interface WebAudioSession {
  stop: () => Promise<Blob | null>;
  abort: () => void;
}

/**
 * Preserve the shared audio-capture content-type interface when native code references a browser
 * blob.
 */
export function contentTypeForWebBlob(blob: Blob): string {
  return blob.type || 'audio/webm';
}

/**
 * Return no browser recording session on native platforms, where Expo Audio owns microphone
 * capture.
 */
export async function startWebAudioCapture(): Promise<WebAudioSession | null> {
  return null;
}
