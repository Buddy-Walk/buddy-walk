import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, AccessibilityInfo } from 'react-native';
import { submitFeedback } from '../api/feedback';
import { track, Events } from '../api/telemetry';
import { tap } from '../utils/haptics';

interface AnswerFeedbackProps {
  /** The answer text being rated; changing it resets the control. */
  answer: string;
  /** The question that produced the answer (PII-free context). */
  question?: string;
}

/** Lightweight thumbs up/down rating shown under each AI answer. */
export default function AnswerFeedback({
  answer,
  question,
}: AnswerFeedbackProps): React.JSX.Element | null {
  const [rated, setRated] = useState<number | null>(null);

  useEffect(() => {
    // Reset the rating when a different answer is displayed so each answer can receive its own
    // feedback.
    setRated(null);
  }, [answer]);

  if (!answer) return null;

  /**
   * Submit one helpful/unhelpful rating, announce the result, and prevent duplicate ratings for
   * the displayed answer.
   */
  async function rate(value: 1 | -1) {
    if (rated !== null) return;
    tap();
    setRated(value);
    void track(Events.AnswerRated, { rating: value });
    await submitFeedback({
      type: 'answer_rating',
      rating: value,
      context: {
        helpful: value === 1,
        ...(question ? { question: question.slice(0, 200) } : {}),
      },
    });
    AccessibilityInfo.announceForAccessibility(
      value === 1 ? 'Marked helpful. Thank you.' : 'Marked not helpful. Thank you.'
    );
  }

  if (rated !== null) {
    return (
      <Text style={styles.thanks} accessibilityLiveRegion="polite">
        Thanks for your feedback.
      </Text>
    );
  }

  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      <Text style={styles.label}>Was this helpful?</Text>
      <Pressable
        onPress={/* Record that the displayed answer was helpful. */ () => rate(1)}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel="Yes, this answer was helpful"
      >
        <Text style={styles.icon}>👍</Text>
      </Pressable>
      <Pressable
        onPress={/* Record that the displayed answer was not helpful. */ () => rate(-1)}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel="No, this answer was not helpful"
      >
        <Text style={styles.icon}>👎</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  label: {
    color: '#fff',
    fontSize: 16,
    marginRight: 12,
  },
  button: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  icon: {
    fontSize: 28,
  },
  thanks: {
    color: '#9ad29a',
    fontSize: 16,
    marginTop: 12,
  },
});
