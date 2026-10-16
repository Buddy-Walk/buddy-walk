import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, AppState, AppStateStatus } from 'react-native';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { isFirebaseConfigured, subscribeAuthState } from '../api/firebase';
import { clearLocalAppSession } from '../utils/restartAppSession';
import { primeAnalyticsConsent } from '../utils/analyticsConsent';
import { flush, initTelemetry, trackScreen } from '../api/telemetry';
import { AuthSessionContext } from './authSession';
import { RootStackParamList } from '../types';

import WelcomeScreen from '../screens/WelcomeScreen';
import AuthScreen from '../screens/AuthScreen';
import PermissionsScreen from '../screens/PermissionsScreen';
import WaiverScreen from '../screens/WaiverScreen';
import NameScreen from '../screens/NameScreen';
import MainScreen from '../screens/MainScreen';
import CompanionScreen from '../screens/CompanionScreen';
import SavedPlacesScreen from '../screens/SavedPlacesScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

const navigationRef = createNavigationContainerRef<RootStackParamList>();

const BYPASS_AUTH = Constants.expoConfig?.extra?.bypassAuth === true;

/**
 * Choose the authenticated/onboarding navigation tree, manage session resets, and track screen
 * visits and app lifecycle telemetry.
 */
export default function Navigation() {
  const [checking, setChecking] = useState(!BYPASS_AUTH);
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  const [isAuthed, setIsAuthed] = useState(BYPASS_AUTH);
  const [navKey, setNavKey] = useState(0);

  const signOut = useCallback(async () => {
    // Clear local session state and remount navigation after sign-out, respecting builds
    // configured to bypass authentication.
    await clearLocalAppSession();
    setSkipOnboarding(false);
    setIsAuthed(BYPASS_AUTH);
    setNavKey(/* Change the navigator key so no screen state survives the session reset. */ (k) => k + 1);
  }, []);

  const authSession = useMemo(/* Keep the session actions supplied to descendant screens stable between unrelated renders. */ () => ({ signOut }), [signOut]);

  const lastTrackedRoute = useRef<string | undefined>(undefined);

  // Start anonymous usage tracking once, and flush buffered events when the app
  // goes to the background so we don't lose a tester's session.
  useEffect(() => {
    // Initialize analytics consent and telemetry once, and flush buffered events when the app
    // becomes inactive.
    void primeAnalyticsConsent();
    const disposeTelemetry = initTelemetry();
    /** Flush pending analytics as the app moves away from the foreground. */
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') void flush();
    };
    const sub = AppState.addEventListener('change', onAppStateChange);
    return () => {
      // Remove the app-state subscription and telemetry lifecycle resources on navigation
      // teardown.
      sub.remove();
      disposeTelemetry();
    };
  }, []);

  const handleRouteChange = useCallback(() => {
    // Record a screen-view event only when the current navigation route actually changes.
    const current = navigationRef.getCurrentRoute()?.name;
    if (current && current !== lastTrackedRoute.current) {
      lastTrackedRoute.current = current;
      trackScreen(current);
    }
  }, []);

  useEffect(() => {
    // Resolve authentication and onboarding state before choosing the initial screen, including
    // the explicit bypass-auth build path.
    if (BYPASS_AUTH) {
      void (async () => {
        // Restore the onboarding flag for a bypass-auth build before dismissing its startup
        // loading state.
        const flag = await AsyncStorage.getItem('onboardingComplete');
        setSkipOnboarding(flag === 'true');
        setChecking(false);
      })();
      return;
    }

    if (!isFirebaseConfigured()) {
      setIsAuthed(false);
      setSkipOnboarding(false);
      setChecking(false);
      return;
    }

    const unsubscribe = subscribeAuthState(async (user) => {
      // Update the navigation gate from Firebase authentication changes and the persisted
      // onboarding flag.
      if (user) {
        setIsAuthed(true);
        const flag = await AsyncStorage.getItem('onboardingComplete');
        setSkipOnboarding(flag === 'true');
      } else {
        setIsAuthed(false);
        setSkipOnboarding(false);
      }
      setChecking(false);
    });
    return unsubscribe;
  }, []);

  if (checking) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  const authedInitialRoute: keyof RootStackParamList =
    skipOnboarding ? 'Main' : 'Permissions';

  return (
    <AuthSessionContext.Provider value={authSession}>
    <NavigationContainer
      key={navKey}
      ref={navigationRef}
      onReady={handleRouteChange}
      onStateChange={handleRouteChange}
    >
      <Stack.Navigator
        initialRouteName={isAuthed ? authedInitialRoute : 'Welcome'}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#000' },
          animation: 'slide_from_right',
        }}
      >
        {!isAuthed ? (
          <>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen name="Auth" component={AuthScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Permissions" component={PermissionsScreen} />
            <Stack.Screen name="Waiver" component={WaiverScreen} />
            <Stack.Screen name="Name" component={NameScreen} />
            <Stack.Screen name="Main" component={MainScreen} />
            <Stack.Screen name="Companion" component={CompanionScreen} />
            <Stack.Screen name="SavedPlaces" component={SavedPlacesScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
    </AuthSessionContext.Provider>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
