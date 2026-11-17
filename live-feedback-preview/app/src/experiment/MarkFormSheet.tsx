import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { emptyMarkDraft, validateMarkForm, type MarkDraft, type MarkFields, type MarkFormResult } from './markForm';

type Props = {
  /** The Readings in the marked frame, shown so the tester can see what the app read. */
  readingTexts: string[];
  onSave: (fields: MarkFields) => void;
  onCancel: () => void;
};

type ChoiceField = Exclude<keyof MarkDraft, 'distance'>;

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

/** The form for one Mark. The camera keeps running behind it. */
export function MarkFormSheet({ readingTexts, onSave, onCancel }: Props) {
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
              <Text style={styles.label}>Distance in feet</Text>
              <TextInput
                accessibilityLabel="Distance in feet"
                keyboardType="decimal-pad"
                value={draft.distance}
                onChangeText={(distance) => setDraft((current) => ({ ...current, distance }))}
                style={styles.input}
                placeholder="25"
                placeholderTextColor="#888"
              />
              {errors.distance && <Text style={styles.error}>{errors.distance}</Text>}
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
