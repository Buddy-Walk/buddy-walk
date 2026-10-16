import React from 'react';
import { ScrollView, StyleSheet, Text, Pressable } from 'react-native';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort guard: a crash anywhere in the tree renders a readable, spoken
 * error message instead of a silent white screen. Critical for blind testers
 * who would otherwise get no feedback at all.
 */
export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  /** Capture a render failure in boundary state so the app can show an accessible recovery screen. */
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  /**
   * Record the caught error and component stack for diagnosis without rethrowing into the app
   * root.
   */
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('AppErrorBoundary caught:', error, info.componentStack);
  }

  /** Render the child app normally, or an accessible recovery view after a component error. */
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        accessibilityLiveRegion="assertive"
      >
        <Text style={styles.title} accessibilityRole="header">
          Something went wrong
        </Text>
        <Text style={styles.message}>
          Buddy Walk hit an unexpected error. Please reload the app — and if this keeps
          happening, let us know what you were doing when it occurred.
        </Text>
        <Pressable
          onPress={/* Clear the captured error so React can try rendering the child application again. */ () => this.setState({ error: null })}
          style={/* Show the recovery button's pressed state without changing its accessible label. */ ({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Text style={styles.buttonLabel}>TRY AGAIN</Text>
        </Pressable>
        <Text style={styles.detail}>{String(this.state.error?.message ?? this.state.error)}</Text>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { padding: 24, gap: 16, paddingTop: 80 },
  title: { color: '#fff', fontSize: 24, fontWeight: 'bold' },
  message: { color: '#fff', fontSize: 16, lineHeight: 24 },
  button: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonPressed: { backgroundColor: '#e0e0e0' },
  buttonLabel: { color: '#000', fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },
  detail: { color: '#fff', fontSize: 12, marginTop: 16 },
});
