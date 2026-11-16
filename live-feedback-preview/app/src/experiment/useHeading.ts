import * as Location from 'expo-location';
import { useEffect, useRef } from 'react';

import type { Heading } from './session';

/**
 * Watches the compass while `active`, and returns a ref holding the latest heading, or null before
 * the first one. iOS only gives a heading with location permission, which this asks for as soon as
 * the screen opens, so the question never interrupts a session.
 */
export function useHeading(active: boolean) {
  const latest = useRef<Heading | null>(null);
  const [permission] = Location.useForegroundPermissions({ request: true });
  const granted = permission?.granted ?? false;

  useEffect(() => {
    if (!active || !granted) return;
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;

    (async () => {
      const watch = await Location.watchHeadingAsync((heading) => {
        latest.current = {
          trueDegrees: heading.trueHeading >= 0 ? heading.trueHeading : null,
          magneticDegrees: heading.magHeading,
          accuracy: heading.accuracy as Heading['accuracy'],
        };
      });
      if (cancelled) watch.remove();
      else subscription = watch;
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
      latest.current = null;
    };
  }, [active, granted]);

  return latest;
}
