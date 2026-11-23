import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { NativeNitroImage, type Image } from 'react-native-nitro-image';

import type { Size } from '../readings/Reading';
import { containedSize } from '../readings/ReadingsCamera';
import {
  emptyMarkDraft,
  markConditions,
  targetPointAt,
  toggleCondition,
  validateMarkForm,
  type ConditionChoice,
  type MarkDraft,
  type MarkFields,
  type MarkFormResult,
  type TargetPoint,
} from './markForm';

type Props = {
  /** The marked frame, upright, for the tester to tap the target on. */
  frame: Image;
  /** The Readings in the marked frame, shown so the tester can see what the app read. */
  readingTexts: string[];
  onSave: (fields: MarkFields) => void;
  onCancel: () => void;
};

type ChoiceField = 'targetKind' | 'side' | 'visibleToTester' | 'signStyle';

const choices: { [Field in ChoiceField]: { label: string; options: { value: NonNullable<MarkDraft[Field]>; label: string }[] } } = {
  targetKind: {
    label: 'Target',
    options: [
      { value: 'door-number', label: 'Door number' },
      { value: 'sign', label: 'Sign' },
    ],
  },
  side: {
    label: 'Side',
    options: [
      { value: 'same-sidewalk', label: 'Same sidewalk' },
      { value: 'across-street', label: 'Across the street' },
    ],
  },
  visibleToTester: {
    label: 'Can you read it yourself?',
    options: [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ],
  },
  signStyle: {
    label: 'Style',
    options: [
      { value: 'plain', label: 'Plain' },
      { value: 'stylised', label: 'Stylised' },
      { value: 'angled', label: 'Angled' },
    ],
  },
};

const choiceFields = Object.keys(choices) as ChoiceField[];

const conditionLabels: Record<ConditionChoice, string> = {
  clear: 'Clear',
  faded: 'Faded',
  dirty: 'Dirty',
  damaged: 'Damaged',
  obstructed: 'Obstructed',
  glare: 'Glare',
  dark: 'Dark',
  other: 'Other',
};

const conditionOptions = [...markConditions, 'other' as const].map((value) => ({ value, label: conditionLabels[value] }));

/** The form for one Mark. The camera keeps running behind it. */
export function MarkFormSheet({ frame, readingTexts, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<MarkDraft>(emptyMarkDraft);
  const [result, setResult] = useState<MarkFormResult | null>(null);
  const errors = result && !result.ok ? result.errors : {};

  function save() {
    const validated = validateMarkForm(draft);
    setResult(validated);
    if (validated.ok) onSave(validated.fields);
  }

  return (
    <Modal transparent animationType="slide" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={styles.title} accessibilityRole="header">
              Mark
            </Text>
            <Text style={styles.readingTexts}>
              {readingTexts.length > 0 ? `Read: ${readingTexts.join(' · ')}` : 'Nothing read in this frame.'}
            </Text>

            <View style={styles.field}>
              <Text style={styles.label}>What does it say?</Text>
              <Text style={styles.hint}>As written on it. For a sign on several lines, the line you tap.</Text>
              {/* Typed exactly as written, so nothing the keyboard would change is turned on. */}
              <TextInput
                accessibilityLabel="What does it say?"
                value={draft.targetText}
                onChangeText={(targetText) => setDraft((current) => ({ ...current, targetText }))}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                style={styles.input}
                placeholder="1247 or Joe's Pizza"
                placeholderTextColor="#888"
              />
              {errors.targetText && <Text style={styles.error}>{errors.targetText}</Text>}
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Where is it?</Text>
              <Text style={styles.hint}>Tap the target on the frame. Tap again to move it.</Text>
              <TargetPointPicker
                frame={frame}
                point={draft.targetPoint}
                onChange={(targetPoint) => setDraft((current) => ({ ...current, targetPoint }))}
              />
              {errors.targetPoint && <Text style={styles.error}>{errors.targetPoint}</Text>}
            </View>

            {choiceFields.map((field) => (
              <View key={field} style={styles.field}>
                <Text style={styles.label}>{choices[field].label}</Text>
                <View style={styles.options} accessibilityRole="radiogroup">
                  {choices[field].options.map((option) => {
                    const selected = draft[field] === option.value;
                    return (
                      <Pressable
                        key={String(option.value)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        accessibilityLabel={`${choices[field].label}: ${option.label}`}
                        onPress={() => setDraft((current) => ({ ...current, [field]: option.value }))}
                        style={[styles.option, selected && styles.optionSelected]}
                      >
                        <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                {errors[field] && <Text style={styles.error}>{errors[field]}</Text>}
              </View>
            ))}

            <View style={styles.field}>
              <Text style={styles.label}>Conditions</Text>
              <View style={styles.options}>
                {conditionOptions.map((option) => {
                  const selected = draft.conditions.includes(option.value);
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`Conditions: ${option.label}`}
                      onPress={() =>
                        setDraft((current) => ({ ...current, conditions: toggleCondition(current.conditions, option.value) }))
                      }
                      style={[styles.option, selected && styles.optionSelected]}
                    >
                      <Text style={[styles.optionText, selected && styles.optionTextSelected]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {errors.conditions && <Text style={styles.error}>{errors.conditions}</Text>}
              {draft.conditions.includes('other') && (
                <>
                  <TextInput
                    accessibilityLabel="Other condition"
                    value={draft.otherCondition}
                    onChangeText={(otherCondition) => setDraft((current) => ({ ...current, otherCondition }))}
                    style={[styles.input, styles.otherCondition]}
                    placeholder="What makes it hard to read"
                    placeholderTextColor="#888"
                  />
                  {errors.otherCondition && <Text style={styles.error}>{errors.otherCondition}</Text>}
                </>
              )}
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Distance to the target in feet</Text>
              <Text style={styles.hint}>Measured with the laser measure.</Text>
              <TextInput
                accessibilityLabel="Distance to the target in feet"
                keyboardType="decimal-pad"
                value={draft.targetDistance}
                onChangeText={(targetDistance) => setDraft((current) => ({ ...current, targetDistance }))}
                style={styles.input}
                placeholder="25"
                placeholderTextColor="#888"
              />
              {errors.targetDistance && <Text style={styles.error}>{errors.targetDistance}</Text>}
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Distance to the wall in front in feet</Text>
              <Text style={styles.hint}>
                Measured with the laser measure to the wall straight ahead of you, on the target's side of the street.
              </Text>
              <TextInput
                accessibilityLabel="Distance to the wall in front in feet"
                keyboardType="decimal-pad"
                value={draft.wallDistance}
                onChangeText={(wallDistance) => setDraft((current) => ({ ...current, wallDistance }))}
                style={styles.input}
                placeholder="20"
                placeholderTextColor="#888"
              />
              {errors.wallDistance && <Text style={styles.error}>{errors.wallDistance}</Text>}
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>Notes (optional)</Text>
              <TextInput
                accessibilityLabel="Notes"
                multiline
                value={draft.note}
                onChangeText={(note) => setDraft((current) => ({ ...current, note }))}
                style={[styles.input, styles.note]}
                placeholder="Anything else about the target or this moment"
                placeholderTextColor="#888"
              />
            </View>

            <View style={styles.actions}>
              <Pressable accessibilityRole="button" onPress={onCancel} style={[styles.action, styles.cancel]}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={save} style={[styles.action, styles.save]}>
                <Text style={styles.saveText}>Save Mark</Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** The tallest the frame is shown, so the rest of the form stays in reach. */
const FRAME_MAX_HEIGHT = 360;

const MARKER_SIZE = 28;

/** The Mark's frame, where a tap sets the target point and shows it. */
function TargetPointPicker({
  frame,
  point,
  onChange,
}: {
  frame: Image;
  point: TargetPoint | null;
  onChange: (point: TargetPoint) => void;
}) {
  const [width, setWidth] = useState<number | null>(null);
  // Shown at the frame's own aspect ratio, so a tap's place in the view is its place in the frame.
  const shown: Size | null =
    width === null ? null : containedSize({ width: frame.width, height: frame.height }, { width, height: FRAME_MAX_HEIGHT });

  return (
    <View style={styles.frameArea} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {shown && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Frame"
          accessibilityHint="Tap the target to mark where it is"
          accessibilityValue={{ text: point ? 'Target marked' : 'No target marked' }}
          // `locationX` and `locationY` are measured from the view the touch lands on, so the
          // frame's contents let touches through to this one.
          onPress={(event) => onChange(targetPointAt({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }, shown))}
          style={shown}
        >
          <NativeNitroImage image={frame} resizeMode="stretch" style={StyleSheet.absoluteFill} pointerEvents="none" />
          {point && (
            <View
              pointerEvents="none"
              style={[styles.marker, { left: point.x * shown.width - MARKER_SIZE / 2, top: point.y * shown.height - MARKER_SIZE / 2 }]}
            />
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '80%',
    padding: 20,
    paddingBottom: 36,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    backgroundColor: '#1c1c1e',
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
  },
  readingTexts: {
    color: '#ccc',
    fontSize: 15,
    marginTop: 4,
  },
  hint: {
    color: '#ccc',
    fontSize: 14,
    marginTop: -4,
    marginBottom: 8,
  },
  frameArea: {
    alignItems: 'center',
  },
  marker: {
    position: 'absolute',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_SIZE / 2,
    borderWidth: 3,
    borderColor: '#ffd60a',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
  },
  field: {
    marginTop: 16,
  },
  label: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  option: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#666',
  },
  optionSelected: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  optionText: {
    color: '#fff',
    fontSize: 16,
  },
  optionTextSelected: {
    color: '#000',
  },
  input: {
    color: '#fff',
    fontSize: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#666',
  },
  otherCondition: {
    marginTop: 8,
  },
  note: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  error: {
    color: '#ff8a80',
    fontSize: 14,
    marginTop: 6,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  action: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 10,
  },
  cancel: {
    borderWidth: 1,
    borderColor: '#666',
  },
  cancelText: {
    color: '#fff',
    fontSize: 17,
  },
  save: {
    backgroundColor: '#fff',
  },
  saveText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '600',
  },
});
