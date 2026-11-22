import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { SessionStore, SessionSummary } from './sessionStore';

type Props = {
  store: SessionStore;
  onClose: () => void;
};

/**
 * Past experiment sessions, each with a way to export it through the share sheet and to delete it.
 * Select picks several, or all, to export as one archive or delete together.
 */
export function PastSessions({ store, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>(() => store.list());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // In list order, newest first. A session that cannot be read can be deleted but not exported.
  const selectedSessions = sessions.filter((session) => selected.has(session.id));
  const exportable = selectedSessions.filter((session) => session.readable).map((session) => session.id);
  const allSelected = sessions.length > 0 && selectedSessions.length === sessions.length;

  async function share(ids: string[]) {
    // The list is newest first, so the oldest session is last.
    const name = ids.length === 1 ? ids[0] : `experiment-sessions-${ids.at(-1)}-to-${ids[0]}`;
    try {
      const archive = new File(Paths.cache, `${name}.zip`);
      archive.create({ overwrite: true });
      archive.writeSync(store.exportArchive(ids));
      await Sharing.shareAsync(archive.uri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: ids.length === 1 ? `Session ${ids[0]}` : `${ids.length} sessions`,
      });
    } catch (error) {
      Alert.alert(ids.length === 1 ? 'Could not export the session' : 'Could not export the sessions', String(error));
    }
  }

  function confirmDelete(ids: string[]) {
    const [title, message] =
      ids.length === 1
        ? ['Delete this session?', 'Its Readings, Marks and frames are removed from this phone.']
        : [`Delete ${ids.length} sessions?`, 'Their Readings, Marks and frames are removed from this phone.'];
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          for (const id of ids) store.remove(id);
          setSessions(store.list());
          stopSelecting();
        },
      },
    ]);
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Past sessions
          </Text>
          <View style={styles.headerActions}>
            {selecting ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setSelected(allSelected ? new Set() : new Set(sessions.map((session) => session.id)))}
                  hitSlop={12}
                >
                  <Text style={styles.headerAction}>{allSelected ? 'Deselect All' : 'Select All'}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={stopSelecting} hitSlop={12}>
                  <Text style={styles.headerActionStrong}>Cancel</Text>
                </Pressable>
              </>
            ) : (
              <>
                {sessions.length > 0 && (
                  <Pressable accessibilityRole="button" onPress={() => setSelecting(true)} hitSlop={12}>
                    <Text style={styles.headerAction}>Select</Text>
                  </Pressable>
                )}
                <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
                  <Text style={styles.headerActionStrong}>Done</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
        <FlatList
          data={sessions}
          extraData={selecting ? selected : null}
          keyExtractor={(session) => session.id}
          ListEmptyComponent={<Text style={styles.empty}>No sessions yet.</Text>}
          renderItem={({ item }) => {
            const name = item.readable ? new Date(item.startedAt).toLocaleString() : item.id;
            const details = (
              <>
                <Text style={styles.rowTitle}>{name}</Text>
                <Text style={styles.rowDetail}>
                  {item.readable
                    ? `${item.readingCount} Readings, ${item.markCount} Marks${item.endedAt === null ? ', cut off' : ''}`
                    : 'This session cannot be read.'}
                </Text>
              </>
            );

            if (selecting) {
              const checked = selected.has(item.id);
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={`Session from ${name}`}
                  accessibilityState={{ checked }}
                  onPress={() => toggle(item.id)}
                  style={[styles.row, styles.selectableRow]}
                >
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <View style={styles.rowDetails}>{details}</View>
                </Pressable>
              );
            }

            return (
              <View style={styles.row}>
                {details}
                <View style={styles.rowActions}>
                  {item.readable && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Export session from ${name}`}
                      onPress={() => share([item.id])}
                      style={[styles.rowAction, styles.shareAction]}
                    >
                      <Text style={styles.shareText}>Export</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete session from ${name}`}
                    onPress={() => confirmDelete([item.id])}
                    style={[styles.rowAction, styles.deleteAction]}
                  >
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
        {selecting && (
          <View style={styles.selectionBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Export ${exportable.length} selected sessions`}
              accessibilityState={{ disabled: exportable.length === 0 }}
              disabled={exportable.length === 0}
              onPress={() => share(exportable)}
              style={[styles.selectionAction, styles.shareAction, exportable.length === 0 && styles.disabled]}
            >
              <Text style={styles.shareText}>Export {exportable.length}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${selectedSessions.length} selected sessions`}
              accessibilityState={{ disabled: selectedSessions.length === 0 }}
              disabled={selectedSessions.length === 0}
              onPress={() => confirmDelete(selectedSessions.map((session) => session.id))}
              style={[styles.selectionAction, styles.deleteAction, selectedSessions.length === 0 && styles.disabled]}
            >
              <Text style={styles.deleteText}>Delete {selectedSessions.length}</Text>
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 20,
  },
  title: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 20,
  },
  headerAction: {
    color: '#fff',
    fontSize: 17,
  },
  headerActionStrong: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  empty: {
    color: '#ccc',
    fontSize: 17,
    padding: 20,
  },
  row: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#444',
  },
  selectableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  rowDetails: {
    flex: 1,
  },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#888',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    borderColor: '#fff',
    backgroundColor: '#fff',
  },
  checkmark: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
  rowTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  rowDetail: {
    color: '#ccc',
    fontSize: 15,
    marginTop: 2,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 10,
  },
  rowAction: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  selectionBar: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#444',
  },
  selectionAction: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 10,
  },
  shareAction: {
    backgroundColor: '#fff',
  },
  shareText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteAction: {
    borderWidth: 1,
    borderColor: '#ff8a80',
  },
  deleteText: {
    color: '#ff8a80',
    fontSize: 16,
  },
  disabled: {
    opacity: 0.4,
  },
});
