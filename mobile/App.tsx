import './src/polyfills';
import './src/sentry';
import React from 'react';
import { PaperProvider, MD3DarkTheme } from 'react-native-paper';
import { StatusBar } from 'expo-status-bar';
import * as Sentry from '@sentry/react-native';
import Navigation from './src/navigation';
import AppErrorBoundary from './src/components/AppErrorBoundary';

const theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    background: '#000000',
    surface: '#1a1a1a',
    primary: '#ffffff',
    onPrimary: '#000000',
    onBackground: '#ffffff',
    onSurface: '#ffffff',
    onSurfaceVariant: '#ffffff',
    outline: '#ffffff',
    outlineVariant: '#ffffff',
  },
};

function App() {
  return (
    <AppErrorBoundary>
      <PaperProvider theme={theme}>
        <StatusBar style="light" />
        <Navigation />
      </PaperProvider>
    </AppErrorBoundary>
  );
}

export default Sentry.wrap(App);
