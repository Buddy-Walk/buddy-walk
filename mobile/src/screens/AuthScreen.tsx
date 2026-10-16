import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, Platform, View } from 'react-native';
import { Text, TextInput, Button, HelperText, Divider } from 'react-native-paper';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { RootStackParamList } from '../types';
import {
  FIREBASE_SETUP_MSG,
  isFirebaseConfigured,
  signInWithAppleIdentityToken,
  signInWithEmailPassword,
  signInWithGoogleIdToken,
  signUpWithEmailPassword,
} from '../api/firebase';

WebBrowser.maybeCompleteAuthSession();

type Props = NativeStackScreenProps<RootStackParamList, 'Auth'>;

/**
 * Render accessible email, Google, and Apple authentication flows and route successful sessions to
 * permission onboarding.
 */
export default function AuthScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isCreating, setIsCreating] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [appleAvailable, setAppleAvailable] = useState(false);

  const [googleRequest, googleResponse, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    androidClientId: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID,
    clientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  });

  useEffect(() => {
    // Check whether Apple sign-in is available on this device before showing its authentication
    // option.
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync()
        .then(setAppleAvailable)
        .catch(/* Hide Apple sign-in when the platform availability check fails. */ () => setAppleAvailable(false));
    }
  }, []);

  useEffect(() => {
    // Consume Google authentication results, requiring an identity token before exchanging it
    // for a Firebase session.
    if (googleResponse?.type === 'success') {
      const idToken = googleResponse.params?.id_token;
      if (idToken) {
        finishGoogleSignIn(idToken);
      } else {
        setErrorMessage('Google sign-in did not return an ID token.');
      }
    } else if (googleResponse?.type === 'error') {
      setErrorMessage(googleResponse.error?.message ?? 'Google sign-in failed.');
    }
  }, [googleResponse]);

  const buttonLabel = isCreating ? 'Create Account' : 'Sign In';
  const modeLabel = isCreating ? 'Already have an account? Sign In' : 'Need an account? Create one';
  const canSubmit = useMemo(
    /**
     * Enable email authentication only after basic input requirements are met and no submission is
     * running.
     */
    () => email.trim().length > 3 && password.length >= 6 && !submitting,
    [email, password, submitting]
  );

  /**
   * Exchange a Google identity token for the app session and present any resulting authentication
   * error.
   */
  async function finishGoogleSignIn(idToken: string) {
    setSubmitting(true);
    setErrorMessage('');
    try {
      await signInWithGoogleIdToken(idToken);
      navigation.replace('Permissions');
    } catch (error: any) {
      setErrorMessage(error?.message ?? 'Unable to sign in with Google.');
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Create or sign in to an email/password account, normalize the email, and continue to
   * permissions after success.
   */
  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage('');
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (isCreating) {
        await signUpWithEmailPassword(normalizedEmail, password);
      } else {
        await signInWithEmailPassword(normalizedEmail, password);
      }
      navigation.replace('Permissions');
    } catch (error: any) {
      setErrorMessage(error?.message ?? 'Unable to authenticate. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Launch Google's authorization prompt and surface errors that occur before a response is
   * returned.
   */
  async function handleGooglePress() {
    setErrorMessage('');
    try {
      await promptGoogle();
    } catch (error: any) {
      setErrorMessage(error?.message ?? 'Unable to start Google sign-in.');
    }
  }

  /**
   * Create an Apple nonce, request Apple identity credentials, and exchange the token plus
   * original nonce for a Firebase session.
   */
  async function handleApplePress() {
    setErrorMessage('');
    setSubmitting(true);
    try {
      const rawNonce = generateRawNonce();
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce
      );
      const appleCredential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
      if (!appleCredential.identityToken) {
        throw new Error('Apple did not return an identity token.');
      }
      await signInWithAppleIdentityToken(appleCredential.identityToken, rawNonce);
      navigation.replace('Permissions');
    } catch (error: any) {
      if (error?.code === 'ERR_REQUEST_CANCELED') {
        // User aborted; no error UI needed.
      } else {
        setErrorMessage(error?.message ?? 'Unable to sign in with Apple.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Scrollable so the submit button stays reachable with zoomed / large accessibility text
          and while the keyboard is open. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} variant="headlineMedium" accessibilityRole="header">
          {isCreating ? 'Create your account' : 'Sign in'}
        </Text>
        <Text style={styles.subtitle}>Use your email, Google, or Apple account to continue.</Text>

        {!isFirebaseConfigured() && (
          <HelperText type="error" visible style={styles.setupHint}>
            {FIREBASE_SETUP_MSG}
          </HelperText>
        )}

        <Button
          mode="contained"
          onPress={handleGooglePress}
          disabled={!googleRequest || submitting}
          icon="google"
          style={styles.providerButton}
          contentStyle={styles.providerButtonContent}
          labelStyle={styles.providerButtonLabel}
          accessibilityLabel="Continue with Google"
        >
          Continue with Google
        </Button>

        {appleAvailable && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={
              isCreating
                ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
                : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
            }
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={40}
            style={styles.appleButton}
            onPress={handleApplePress}
          />
        )}

        <View style={styles.dividerRow}>
          <Divider style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <Divider style={styles.dividerLine} />
        </View>

        <TextInput
          label="Email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          mode="outlined"
          outlineColor="#fff"
          activeOutlineColor="#fff"
          textColor="#fff"
          style={styles.input}
          placeholderTextColor="rgba(255,255,255,0.75)"
        />
        <TextInput
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType={isCreating ? 'newPassword' : 'password'}
          autoComplete={isCreating ? 'password-new' : 'password'}
          mode="outlined"
          outlineColor="#fff"
          activeOutlineColor="#fff"
          textColor="#fff"
          style={styles.input}
          placeholderTextColor="rgba(255,255,255,0.75)"
        />
        <HelperText type="info" style={styles.helpText}>
          Password must be at least 6 characters.
        </HelperText>
        {!!errorMessage && (
          <HelperText type="error" visible>
            {errorMessage}
          </HelperText>
        )}

        <Button
          mode="contained"
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={submitting}
          style={styles.primaryButton}
          contentStyle={styles.primaryButtonContent}
          labelStyle={styles.primaryButtonLabel}
        >
          {buttonLabel}
        </Button>

        <Button
          mode="text"
          onPress={/* Switch the email form between account creation and sign-in. */ () => setIsCreating(/* Invert the existing account-mode state without closing over an older render. */ (prev) => !prev)}
          textColor="#fff"
          disabled={submitting}
        >
          {modeLabel}
        </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Build the nonce string paired with an Apple sign-in request and its Firebase credential
 * exchange.
 */
function generateRawNonce(): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return result;
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
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  title: {
    color: '#fff',
    fontWeight: 'bold',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    color: '#fff',
    textAlign: 'center',
    marginBottom: 20,
  },
  providerButton: {
    borderRadius: 40,
    backgroundColor: '#fff',
    marginBottom: 12,
  },
  providerButtonContent: {
    paddingVertical: 8,
  },
  providerButtonLabel: {
    color: '#000',
    fontSize: 16,
    fontWeight: 'bold',
  },
  appleButton: {
    height: 48,
    marginBottom: 12,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 12,
  },
  dividerLine: {
    flex: 1,
    backgroundColor: '#444',
    height: 1,
  },
  dividerText: {
    color: '#fff',
    paddingHorizontal: 12,
  },
  input: {
    backgroundColor: '#000',
    marginBottom: 12,
  },
  setupHint: {
    color: '#ff8a80',
    marginBottom: 12,
    lineHeight: 20,
  },
  helpText: {
    color: '#fff',
    marginBottom: 8,
  },
  primaryButton: {
    borderRadius: 40,
    backgroundColor: '#fff',
    marginTop: 8,
  },
  primaryButtonContent: {
    paddingVertical: 10,
  },
  primaryButtonLabel: {
    color: '#000',
    fontSize: 17,
    fontWeight: 'bold',
  },
});
