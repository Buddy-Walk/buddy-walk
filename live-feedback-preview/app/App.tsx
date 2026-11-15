import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ExperimentScreen } from './src/experiment/ExperimentScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <ExperimentScreen />
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
