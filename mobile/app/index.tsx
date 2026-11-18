import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect } from 'expo-router';

import { logger } from '../lib/logger';
import {
  type OnboardingStorage,
  initialRouteFor,
  readOnboarded,
} from '../lib/onboarding';
import { colors } from '../lib/theme';

/**
 * Entry route: the initial route depends on whether the onboarding already
 * finished (`gentle-movil:onboarded`, task T7p).
 *
 * - onboarded → `/overview` (V5), so an owner who already paired never lands on
 *   the QR scan again;
 * - not onboarded (fresh install, cleared flag, or a corrupt value that
 *   `readOnboarded` treats as not onboarded and logs) → `/scan-qr` (V1).
 *
 * Nothing is rendered while the flag is being read: a one-frame redirect to the
 * wrong screen would be visible, so the entry stays blank instead.
 */
export default function Index() {
  const log = useMemo(() => logger.tag('entry'), []);
  const [route, setRoute] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void readOnboarded(AsyncStorage as unknown as OnboardingStorage, log).then((onboarded) => {
      if (!alive) {
        return;
      }
      const target = initialRouteFor(onboarded);
      log.info('ruta inicial', { onboarded, target });
      setRoute(target);
    });
    return () => {
      alive = false;
    };
  }, [log]);

  if (route === null) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  }

  return <Redirect href={route} />;
}
