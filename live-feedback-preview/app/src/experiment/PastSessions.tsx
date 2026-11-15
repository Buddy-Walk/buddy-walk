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

/** Past experiment sessions, each with a way to export it through the share sheet and to delete it. */
export function PastSessions({ store, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>(() => store.list());

  async function share(id: string) {
    try {
      const archive = new File(Paths.cache, `${id}.zip`);
      archive.create({ overwrite: true });
      archive.writeSync(store.exportArchive(id));
      await Sharing.shareAsync(archive.uri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: `Session ${id}`,
      });
    } catch (error) {
      Alert.alert('Could not export the session', String(error));
    }
  }

  function confirmDelete(id: string) {
    Alert.alert('Delete this session?', 'Its Readings, Marks and frames are removed from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          store.remove(id);
          setSessions(store.list());
        },
      },
    ]);
  }

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Past sessions
          </Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>
        <FlatList
          data={sessions}
          keyExtractor={(session) => session.id}
          ListEmptyComponent={<Text style={styles.empty}>No sessions yet.</Text>}
          renderItem={({ item }) => {
            const name = item.readable ? new Date(item.startedAt).toLocaleString() : item.id;
            return (
              <View style={styles.row}>
                <Text style={styles.rowTitle}>{name}</Text>
                <Text style={styles.rowDetail}>
                  {item.readable
                    ? `${item.readingCount} Readings, ${item.markCount} Marks${item.endedAt === null ? ', cut off' : ''}`
                    : 'This session cannot be read.'}
                </Text>
                <View style={styles.rowActions}>
                  {item.readable && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Export session from ${name}`}
                      onPress={() => share(item.id)}
                      style={[styles.rowAction, styles.shareAction]}
                    >
                      <Text style={styles.shareText}>Export</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete session from ${name}`}
                    onPress={() => confirmDelete(item.id)}
                    style={[styles.rowAction, styles.deleteAction]}
                  >
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
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
  done: {
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
});
