import React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { Text, Button } from 'react-native-paper';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Waiver'>;

/** Present the app's navigation disclaimer in an accessible scrollable screen. */
export default function WaiverScreen({ navigation }: Props) {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title} variant="headlineMedium" accessibilityRole="header">
        Waiver & Disclaimer
      </Text>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.body}>
          This app is designed to assist blind and visually impaired users in navigation and
          localization. However, due to the limitations of AI, GPS accuracy, and real-world
          conditions, the app may not always provide correct or real-time information.{'\n\n'}
          Users should not rely solely on this app for navigation and should use additional
          assistive tools.{'\n\n'}
          By using this app, you acknowledge that you assume full responsibility for your safety
          and agree that the developers are not liable for any accidents, injuries, or damages
          that may occur while using the app.{'\n\n'}
          The AI-generated descriptions may not be fully accurate. Always verify important
          information through other means before making navigation decisions.{'\n\n'}
          Doorfront entrance data is provided by community volunteers and may not reflect current
          conditions.
        </Text>
      </ScrollView>
      <View style={styles.footer}>
        <Button
          mode="contained"
          onPress={/* Return from the disclaimer to the previous onboarding screen. */ () => navigation.goBack()}
          style={styles.button}
          contentStyle={styles.buttonContent}
          labelStyle={styles.buttonLabel}
          accessibilityLabel="Go back to permissions screen"
        >
          Back
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    paddingHorizontal: 20,
  },
  title: {
    color: '#fff',
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 12,
    letterSpacing: 1,
  },
  scroll: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  body: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 24,
  },
  footer: {
    paddingVertical: 16,
  },
  button: {
    borderRadius: 40,
    backgroundColor: '#fff',
  },
  buttonContent: {
    paddingVertical: 8,
  },
  buttonLabel: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
