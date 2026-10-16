import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { Text, TextInput, Button } from 'react-native-paper';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RootStackParamList } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Name'>;

/** Collect the optional display name used by the mobile experience before opening the main screen. */
export default function NameScreen({ navigation }: Props) {
  const [name, setName] = useState('');

  /**
   * Persist a nonempty trimmed display name and finish onboarding by replacing this screen with
   * Main.
   */
  async function handleContinue() {
    if (name.trim()) {
      await AsyncStorage.setItem('name', name.trim());
    }
    navigation.replace('Main');
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Scrollable so the Continue button stays reachable with zoomed / large accessibility text
          and while the keyboard is open. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} variant="headlineMedium" accessibilityRole="header">
          What should we call you?
        </Text>
        <Text style={styles.subtitle}>
          This is optional — it helps personalize your chat history.
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your name (optional)"
          placeholderTextColor="rgba(255,255,255,0.75)"
          style={styles.input}
          mode="outlined"
          outlineColor="#fff"
          activeOutlineColor="#fff"
          textColor="#fff"
          accessibilityLabel="Enter your name"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleContinue}
        />
        <Button
          mode="contained"
          onPress={handleContinue}
          style={styles.button}
          contentStyle={styles.buttonContent}
          labelStyle={styles.buttonLabel}
          accessibilityLabel={name.trim() ? 'Continue with name' : 'Skip and continue'}
        >
          {name.trim() ? 'Continue' : 'Skip'}
        </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 40,
    paddingBottom: 24,
    gap: 20,
  },
  title: {
    color: '#fff',
    fontWeight: 'bold',
    textAlign: 'center',
  },
  subtitle: {
    color: '#fff',
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 22,
  },
  input: {
    backgroundColor: '#000',
    fontSize: 18,
  },
  button: {
    borderRadius: 40,
    backgroundColor: '#fff',
    marginTop: 8,
  },
  buttonContent: {
    paddingVertical: 10,
  },
  buttonLabel: {
    color: '#000',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
