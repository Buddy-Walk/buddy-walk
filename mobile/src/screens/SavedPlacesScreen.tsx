import { useCallback, useEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  TextInput,
  Alert,
  Pressable,
  AccessibilityInfo,
} from 'react-native';
import { Text, IconButton, ActivityIndicator } from 'react-native-paper';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { RootStackParamList } from '../types';
import {
  SavedPlace,
  deletePlace,
  listSavedPlaces,
  savePlace,
} from '../utils/savedPlaces';
import { geocodeNearUser } from '../utils/geocodeNearUser';
import { track, Events } from '../api/telemetry';

type Props = NativeStackScreenProps<RootStackParamList, 'SavedPlaces'>;

const SUGGESTED_ALIASES = ['home', 'work', 'pharmacy', 'doctor', 'gym'];

/**
 * Manage named destination aliases with address lookup, optional coordinates, accessible deletion,
 * and persisted storage.
 */
export default function SavedPlacesScreen({ navigation }: Props) {
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [alias, setAlias] = useState('');
  const [address, setAddress] = useState('');
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [resolvingLocation, setResolvingLocation] = useState(false);

  const reload = useCallback(async () => {
    // Reload the persisted destinations and settle the list's loading state even if reading
    // storage fails.
    setLoading(true);
    try {
      const list = await listSavedPlaces();
      setPlaces(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Populate the saved-place list when the screen opens.
    reload();
  }, [reload]);

  /**
   * Request location and reverse-geocode the current fix to prefill a saved destination's address
   * and coordinates.
   */
  async function handleUseCurrentLocation() {
    setResolvingLocation(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location permission needed', 'Enable location to autofill addresses.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const results = await Location.reverseGeocodeAsync({
        latitude: fix.coords.latitude,
        longitude: fix.coords.longitude,
      });
      const top = results[0];
      if (top) {
        const composed = [
          top.streetNumber,
          top.street,
          top.city,
          top.region,
          top.postalCode,
          top.country,
        ]
          .filter(Boolean)
          .join(', ');
        setAddress(composed || `${fix.coords.latitude}, ${fix.coords.longitude}`);
        setCoords({ lat: fix.coords.latitude, lon: fix.coords.longitude });
      } else {
        setAddress(`${fix.coords.latitude}, ${fix.coords.longitude}`);
        setCoords({ lat: fix.coords.latitude, lon: fix.coords.longitude });
      }
    } catch (e) {
      console.warn('reverse geocode failed:', e);
      Alert.alert('Could not get location', 'Please type the address manually.');
    } finally {
      setResolvingLocation(false);
    }
  }

  /**
   * Reuse verified coordinates or geocode an address with a nearby-location bias, returning null
   * when no usable result is available.
   */
  async function resolveCoordsForAddress(
    addressTrim: string,
    existing?: { lat: number; lon: number } | null
  ): Promise<{ lat: number; lon: number } | null> {
    if (existing) return existing;

    let userCoords: { lat: number; lng: number } | null = null;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        userCoords = { lat: fix.coords.latitude, lng: fix.coords.longitude };
      }
    } catch {
      /* geocode without user bias */
    }

    const geo = await geocodeNearUser(addressTrim, userCoords);
    return geo ? { lat: geo.lat, lon: geo.lng } : null;
  }

  /**
   * Validate and save the alias/address pair, attempt coordinate resolution, refresh the list, and
   * explain when map verification was unavailable.
   */
  async function handleSave() {
    const aliasTrim = alias.trim();
    const addressTrim = address.trim();
    if (!aliasTrim || !addressTrim) {
      Alert.alert('Missing info', 'Please enter both a name and an address.');
      return;
    }
    setBusy(true);
    try {
      const resolved = await resolveCoordsForAddress(addressTrim, coords);
      const saved = await savePlace({
        alias: aliasTrim,
        address: addressTrim,
        lat: resolved?.lat,
        lon: resolved?.lon,
      });
      setAlias('');
      setAddress('');
      setCoords(null);
      await reload();
      const locationNote = resolved
        ? `Saved ${saved.alias} near your current area.`
        : `Saved ${saved.alias}, but the address could not be verified on a map. Directions may be wrong.`;
      Speech.speak(locationNote, { language: 'en-US' });
      AccessibilityInfo.announceForAccessibility(locationNote);
      void track(Events.SavedPlaceCreated, { aliasLength: saved.alias.length });
    } catch (e: any) {
      Alert.alert('Could not save', e?.message ?? 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Ask before removing a saved alias so a screen-reader action cannot silently delete a
   * destination.
   */
  function confirmDelete(place: SavedPlace) {
    Alert.alert(
      'Remove saved place?',
      `"${place.alias}" will no longer auto-resolve in your questions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          /** Delete the confirmed destination, refresh the list, and announce the removal. */
          onPress: async () => {
            await deletePlace(place.id);
            await reload();
            Speech.speak(`Removed ${place.alias}.`, { language: 'en-US' });
            void track(Events.SavedPlaceDeleted, { aliasLength: place.alias.length });
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton
          icon="arrow-left"
          iconColor="#fff"
          size={28}
          onPress={/* Close destination management and return to the previous screen. */ () => navigation.goBack()}
          accessibilityLabel="Back to main screen"
        />
        <Text style={styles.headerTitle} accessibilityRole="header">
          Saved Places
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.lead}>
          Bookmark places you visit often. Buddy Walk will recognize names like
          "home" or "work" inside your questions and use the saved address.
        </Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Add a place</Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            value={alias}
            onChangeText={(text) => {
              // Update the destination alias as the user types.
              setAlias(text);
            }}
            placeholder="e.g. home"
            placeholderTextColor="rgba(255,255,255,0.75)"
            style={styles.input}
            autoCapitalize="none"
            maxLength={40}
            accessibilityLabel="Place nickname"
          />
          <View style={styles.suggestionRow}>
            {SUGGESTED_ALIASES.map(/* Render one suggested alias as an accessible shortcut for filling the name field. */ (s) => (
              <Pressable
                key={s}
                onPress={/* Fill the alias field with this suggestion. */ () => setAlias(s)}
                style={/* Show the pressed appearance of an alias suggestion. */ ({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                accessibilityLabel={`Use suggestion ${s}`}
                accessibilityRole="button"
              >
                <Text style={styles.chipLabel}>{s}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Address</Text>
          <TextInput
            value={address}
            onChangeText={(text) => {
              // Update the address and clear coordinates that belonged to the previous address
              // text.
              setAddress(text);
              setCoords(null);
            }}
            placeholder="123 Main Street, Brooklyn, NY"
            placeholderTextColor="rgba(255,255,255,0.75)"
            style={[styles.input, styles.multiline]}
            multiline
            accessibilityLabel="Street address"
          />
          <Pressable
            onPress={handleUseCurrentLocation}
            disabled={resolvingLocation}
            style={/* Render the current-location autofill control's pressed appearance. */ ({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.secondaryButtonPressed,
            ]}
            accessibilityLabel="Fill address from my current location"
            accessibilityRole="button"
          >
            {resolvingLocation ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.secondaryButtonLabel}>USE MY CURRENT LOCATION</Text>
            )}
          </Pressable>

          <Pressable
            onPress={handleSave}
            disabled={busy}
            style={/* Render the save control's pressed and busy appearances. */ ({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
              busy && styles.primaryButtonDisabled,
            ]}
            accessibilityLabel="Save this place"
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={styles.primaryButtonLabel}>SAVE PLACE</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Your places {places.length > 0 ? `(${places.length})` : ''}
          </Text>

          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : places.length === 0 ? (
            <Text style={styles.empty}>
              No saved places yet. Add one above so you can ask things like "How do I get
              home?".
            </Text>
          ) : (
            places.map(/* Render one saved destination with its spoken summary and both touch and accessibility delete actions. */ (p) => (
              <View
                key={p.id}
                style={styles.placeRow}
                accessible
                accessibilityLabel={`${p.alias}, ${p.address}`}
                accessibilityHint="Use the Remove button to delete this saved place"
                accessibilityActions={[{ name: 'delete', label: `Remove ${p.alias}` }]}
                onAccessibilityAction={(event) => {
                  // Route the screen reader's delete action through the same confirmation as the
                  // visible Remove button.
                  if (event.nativeEvent.actionName === 'delete') confirmDelete(p);
                }}
              >
                <View style={styles.placeText}>
                  <Text style={styles.placeAlias}>{p.alias}</Text>
                  <Text style={styles.placeAddress} numberOfLines={3}>
                    {p.address}
                  </Text>
                  {p.lat != null && p.lon != null ? (
                    <Text style={styles.placeCoords} accessibilityElementsHidden>
                      Verified on map
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  onPress={/* Open deletion confirmation for this saved destination. */ () => confirmDelete(p)}
                  style={/* Show the destination removal button's pressed appearance. */ ({ pressed }) => [
                    styles.removeButton,
                    pressed && styles.removeButtonPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove saved place ${p.alias}`}
                  accessibilityHint="Deletes this saved place from your list"
                >
                  <Text style={styles.removeButtonLabel}>Remove</Text>
                </Pressable>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 4,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  scroll: { padding: 20, gap: 16, flexGrow: 1 },
  lead: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 24,
  },
  card: {
    backgroundColor: '#161b22',
    borderRadius: 16,
    padding: 18,
    gap: 10,
    borderWidth: 1,
    borderColor: '#2a313c',
  },
  cardTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  label: { color: '#fff', fontSize: 14, fontWeight: '700', marginTop: 4 },
  input: {
    backgroundColor: '#0e1116',
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2a313c',
  },
  multiline: { minHeight: 70, textAlignVertical: 'top' },
  suggestionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#2a313c',
    borderRadius: 999,
  },
  chipPressed: { backgroundColor: '#3d4654' },
  chipLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  secondaryButton: {
    borderRadius: 12,
    paddingVertical: 12,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#fff',
    alignItems: 'center',
  },
  secondaryButtonPressed: { opacity: 0.7 },
  secondaryButtonLabel: { color: '#fff', fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },
  primaryButton: {
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 6,
  },
  primaryButtonPressed: { backgroundColor: '#e0e0e0' },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonLabel: { color: '#000', fontSize: 17, fontWeight: 'bold', letterSpacing: 1.2 },
  empty: { color: '#fff', fontSize: 15, lineHeight: 22 },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0e1116',
    borderRadius: 12,
    padding: 12,
    gap: 8,
    borderWidth: 1,
    borderColor: '#2a313c',
  },
  placeText: { flex: 1 },
  placeAlias: { color: '#fff', fontSize: 17, fontWeight: '700' },
  placeAddress: { color: '#fff', fontSize: 14, marginTop: 2 },
  placeCoords: { color: '#6b9e6b', fontSize: 12, marginTop: 4 },
  removeButton: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#3a1f1f',
    borderWidth: 1,
    borderColor: '#ff8a8a',
    minWidth: 88,
    alignItems: 'center',
  },
  removeButtonPressed: { opacity: 0.75 },
  removeButtonLabel: { color: '#ff8a8a', fontSize: 14, fontWeight: '700' },
});
