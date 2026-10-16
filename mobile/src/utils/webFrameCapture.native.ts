export interface WebFrameSession {
  stop: () => string[];
}

/**
 * Return no browser frame-capture session on native devices, which use Expo camera recording and
 * thumbnail extraction.
 */
export function startWebFrameCapture(): WebFrameSession | null {
  return null;
}
