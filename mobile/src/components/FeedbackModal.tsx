import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Switch,
  ScrollView,
  AccessibilityInfo,
} from 'react-native';
import { submitFeedback } from '../api/feedback';
import {
  isAnalyticsOptedOut,
  setAnalyticsOptedOut,
} from '../utils/analyticsConsent';
import { track, Events, flush } from '../api/telemetry';
import { tap } from '../utils/haptics';

interface FeedbackModalProps {
  visible: boolean;
  onDismiss: () => void;
  /** Current screen name, attached as PII-free context. */
  screen?: string;
}

const STARS = [1, 2, 3, 4, 5];

/**
 * Collect general app feedback and analytics consent in an accessible modal, keeping submission
 * state separate from the underlying screen.
 */
export default function FeedbackModal({
  visible,
  onDismiss,
  screen,
}: FeedbackModalProps): React.JSX.Element {
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [optedOut, setOptedOut] = useState(false);

  useEffect(() => {
    // Clear prior feedback and reload analytics consent whenever the modal is opened.
    if (visible) {
      setRating(0);
      setMessage('');
      setSubmitted(false);
      void isAnalyticsOptedOut().then(setOptedOut);
    }
  }, [visible]);

  /**
   * Validate that a rating or comment was entered, submit feedback with screen context, flush
   * telemetry, and announce completion.
   */
  async function handleSubmit() {
    if (rating === 0 && message.trim().length === 0) {
      AccessibilityInfo.announceForAccessibility(
        'Please add a rating or a comment first.'
      );
      return;
    }
    setSubmitting(true);
    try {
      await submitFeedback({
        type: 'general',
        rating: rating > 0 ? rating : undefined,
        message: message.trim() || undefined,
        context: screen ? { screen } : undefined,
      });
      void track(Events.FeedbackSubmitted, { rating, hasMessage: message.trim().length > 0 });
      void flush();
      setSubmitted(true);
      AccessibilityInfo.announceForAccessibility('Thank you for your feedback.');
    } finally {
      setSubmitting(false);
    }
  }

  /** Persist the user's analytics opt-out choice immediately when its switch changes. */
  async function handleToggleOptOut(next: boolean) {
    setOptedOut(next);
    await setAnalyticsOptedOut(next);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onDismiss}
    >
      <View style={styles.backdrop}>
        <View
          style={styles.card}
          accessibilityViewIsModal
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.title} accessibilityRole="header">
              Send Feedback
            </Text>

            {submitted ? (
              <Text style={styles.thanks}>
                Thanks! Your feedback helps us improve Buddy Walk.
              </Text>
            ) : (
              <>
                <Text style={styles.label}>How was your experience?</Text>
                <View style={styles.starsRow} accessibilityRole="radiogroup">
                  {STARS.map(/* Render one accessible star-rating choice and indicate whether it belongs to the selected rating. */ (value) => (
                    <Pressable
                      key={value}
                      onPress={() => {
                        // Confirm the tap and select this star value.
                        tap();
                        setRating(value);
                      }}
                      style={styles.star}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: rating >= value }}
                      accessibilityLabel={`${value} star${value === 1 ? '' : 's'}`}
                    >
                      <Text style={styles.starIcon}>{rating >= value ? '★' : '☆'}</Text>
                    </Pressable>
                  ))}
                </View>

                <Text style={styles.label}>Tell us more (optional)</Text>
                <TextInput
                  value={message}
                  onChangeText={setMessage}
                  multiline
                  numberOfLines={4}
                  placeholder="What worked well? What was confusing?"
                  placeholderTextColor="rgba(255,255,255,0.75)"
                  style={styles.input}
                  accessibilityLabel="Feedback comment"
                />

                <Pressable
                  onPress={handleSubmit}
                  disabled={submitting}
                  style={/* Combine pressed and disabled appearances for the feedback submission button. */ ({ pressed }) => [
                    styles.submit,
                    pressed && styles.submitPressed,
                    submitting && styles.submitDisabled,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Submit feedback"
                >
                  <Text style={styles.submitLabel}>
                    {submitting ? 'Sending...' : 'Submit'}
                  </Text>
                </Pressable>
              </>
            )}

            <View style={styles.optOutRow}>
              <View style={styles.optOutText}>
                <Text style={styles.optOutTitle}>Share anonymous usage data</Text>
                <Text style={styles.optOutSubtitle}>
                  Helps us understand how the app is used. No personal info.
                </Text>
              </View>
              <Switch
                value={!optedOut}
                onValueChange={/* Translate the collection-enabled switch into the stored opt-out preference. */ (on) => handleToggleOptOut(!on)}
                accessibilityLabel="Share anonymous usage data"
              />
            </View>

            <Pressable
              onPress={onDismiss}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel="Close feedback"
            >
              <Text style={styles.closeLabel}>Close</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    maxHeight: '90%',
  },
  title: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 16,
  },
  thanks: {
    color: '#fff',
    fontSize: 18,
    marginBottom: 16,
  },
  label: {
    color: '#fff',
    fontSize: 18,
    marginTop: 12,
    marginBottom: 8,
  },
  starsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  star: {
    padding: 8,
  },
  starIcon: {
    fontSize: 40,
    color: '#ffd24a',
  },
  input: {
    backgroundColor: '#2c2c2e',
    color: '#fff',
    borderRadius: 12,
    padding: 14,
    fontSize: 18,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  submit: {
    backgroundColor: '#2e7d32',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 18,
  },
  submitPressed: {
    opacity: 0.8,
  },
  submitDisabled: {
    opacity: 0.5,
  },
  submitLabel: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  optOutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  optOutText: {
    flex: 1,
    paddingRight: 12,
  },
  optOutTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  optOutSubtitle: {
    color: '#fff',
    fontSize: 13,
    marginTop: 2,
  },
  close: {
    marginTop: 20,
    alignItems: 'center',
    paddingVertical: 12,
  },
  closeLabel: {
    color: '#9ecbff',
    fontSize: 18,
  },
});
