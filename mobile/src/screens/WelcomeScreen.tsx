import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Text, Button } from 'react-native-paper';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Welcome'>;

/** Present the introductory mobile screen and its accessible entry into account onboarding. */
export default function WelcomeScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      {/* Scrollable so the Get Started button stays reachable with zoomed / large accessibility text. */}
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} variant="displaySmall" accessibilityRole="header">
          BUDDY WALK
        </Text>
        <Text style={styles.subtitle} variant="titleMedium">
          AI-Powered Navigation for the Blind and Visually Impaired
        </Text>

        <Button
          mode="contained"
          onPress={/* Start onboarding by opening the authentication screen. */ () => navigation.navigate('Auth')}
          style={styles.button}
          contentStyle={styles.buttonContent}
          labelStyle={styles.buttonLabel}
          accessibilityLabel="Get started with Buddy Walk"
          accessibilityHint="Opens the permissions setup screen"
        >
          Get Started
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
    gap: 24,
  },
  title: {
    color: '#fff',
    fontWeight: 'bold',
    letterSpacing: 4,
    textAlign: 'center',
  },
  subtitle: {
    color: '#fff',
    textAlign: 'center',
    lineHeight: 26,
  },
  button: {
    width: '100%',
    borderRadius: 40,
    backgroundColor: '#fff',
    marginTop: 16,
  },
  buttonContent: {
    paddingVertical: 12,
  },
  buttonLabel: {
    color: '#000',
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
});
