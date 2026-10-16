import React from 'react';
import { Pressable, Text, StyleSheet, Linking } from 'react-native';
import * as Speech from 'expo-speech';
import { tapMedium } from '../utils/haptics';

const AAR_NUMBER = '8773372017';

/**
 * Render the accessible Access-A-Ride call shortcut with tactile confirmation and the system
 * telephone handoff.
 */
export default function CallAccessARideButton() {
  /** Announce the call action and open the system dialer with the Access-A-Ride number. */
  function handlePress() {
    Speech.speak('Calling Access-A-Ride.');
    Linking.openURL(`tel:${AAR_NUMBER}`);
  }

  return (
    <Pressable
      onPressIn={/* Confirm the initial touch with a tactile cue before the phone call action runs. */ () => tapMedium()}
      onPress={handlePress}
      style={/* Display the call shortcut's pressed appearance. */ ({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      accessibilityLabel="Call Access-A-Ride"
      accessibilityRole="button"
      accessibilityHint="Calls Access-A-Ride at 877-337-2017"
    >
      <Text style={styles.icon}>📞</Text>
      <Text style={styles.label}>AAR</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    width: 80,
    height: 80,
    backgroundColor: '#fff',
    borderRadius: 40,
    borderWidth: 2,
    borderColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
    zIndex: 1000,
  },
  buttonPressed: {
    backgroundColor: '#f2f2f2',
  },
  icon: {
    fontSize: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '900',
    color: '#000',
    letterSpacing: 1,
  },
});
