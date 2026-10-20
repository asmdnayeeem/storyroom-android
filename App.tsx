import Slider from '@react-native-community/slider';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Book, openLibrary, readBooks, readSetting, saveBook, writeSetting } from './src/library';
import { readAudioMetadata } from './src/metadata';

type ViewMode = 'all' | 'recent' | 'bookmarks' | 'queue';
type SortMode = 'added' | 'title' | 'progress';
type Settings = { speed: number };

const COLORS = ['#a6b785', '#d18e6a', '#7e9aa5', '#a996b4', '#d1b779'];
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const supportsNativePlaybackService =
  Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled audiobook';
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progressOf(book: Book): number {
  return book.duration > 0 ? Math.min(1, book.position / book.duration) : 0;
}

function queueRank(queue: string[], id: string): number {
  const index = queue.indexOf(id);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function modeLabel(mode: ViewMode): string {
  if (mode === 'recent') return 'Recently played';
  if (mode === 'bookmarks') return 'Bookmarks';
  if (mode === 'queue') return 'Up next';
  return 'Your library';
}

function emptyTitle(mode: ViewMode, librarySize: number, query: string): string {
  if (query.trim()) return 'No books match';
  if (mode === 'all') return librarySize ? 'No books match' : 'Your library is waiting';
  if (mode === 'recent') return 'Nothing played yet';
  if (mode === 'bookmarks') return 'No bookmarks yet';
  return 'Your queue is empty';
}

function emptyDescription(mode: ViewMode, librarySize: number, query: string): string {
  if (query.trim()) return 'Try a different search.';
  if (mode === 'all') {
    return librarySize ? 'Try a different search.' : 'Add audio files from your device to start your audiobook shelf.';
  }
  if (mode === 'recent') return 'Books you listen to will show up here.';
  if (mode === 'bookmarks') return 'Bookmark a listening position to find it here.';
  return 'Add books to your queue and they will appear here.';
}

function chapterIndexAt(book: Book, position: number): number {
  for (let index = book.chapters.length - 1; index >= 0; index -= 1) {
    if (book.chapters[index].start <= position) return index;
  }
  return -1;
}

export default function App() {
  const player = useAudioPlayer(null, { updateInterval: 1000 });
  const status = useAudioPlayerStatus(player);
  const [db, setDb] = useState<SQLite.SQLiteDatabase | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [queue, setQueue] = useState<string[]>([]);
  const [mode, setMode] = useState<ViewMode>('all');
  const [sort, setSort] = useState<SortMode>('added');
  const [query, setQuery] = useState('');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [editBook, setEditBook] = useState<Book | null>(null);
  const [chaptersBook, setChaptersBook] = useState<Book | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  const [loading, setLoading] = useState(true);
  const [libraryRetry, setLibraryRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentBook = books.find((book) => book.id === currentId) ?? null;
  const lastSavedAt = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const handledFinish = useRef(false);
  const playbackSnapshot = useRef({ db, book: currentBook, position: status.currentTime, isLoaded: status.isLoaded });
  playbackSnapshot.current = { db, book: currentBook, position: status.currentTime, isLoaded: status.isLoaded };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      let database: SQLite.SQLiteDatabase | null = null;
      try {
        database = await openLibrary();
        const [storedBooks, storedQueue, settings, lastBookId] = await Promise.all([
          readBooks(database),
          readSetting<string[]>(database, 'queue', []),
          readSetting<Settings>(database, 'settings', { speed: 1 }),
          readSetting<string | null>(database, 'lastBookId', null),
        ]);
        if (!mounted) {
          await database.closeAsync();
          return;
        }
        setDb(database);
        setBooks(storedBooks);
        setQueue(storedQueue.filter((id) => storedBooks.some((book) => book.id === id)));
        setSpeed(settings.speed);
        player.setPlaybackRate(settings.speed);
        const lastBook = storedBooks.find((book) => book.id === lastBookId)
          ?? storedBooks.filter((book) => book.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
        if (lastBook) {
          pendingSeek.current = lastBook.position > 0 ? lastBook.position : null;
          setCurrentId(lastBook.id);
          try {
            player.replace({ uri: lastBook.uri, name: lastBook.title });
          } catch (restoreError) {
            console.error(`Could not restore ${lastBook.title} in the player`, restoreError);
            setError(`Could not restore the previous audiobook: ${errorMessage(restoreError)}`);
          }
        }
      } catch (loadError) {
        console.error('Could not open the audiobook library', loadError);
        setError(`Could not open the library: ${errorMessage(loadError)}`);
        if (database) {
          try {
            await database.closeAsync();
          } catch (closeError) {
            console.error('Could not close the audiobook library after loading failed', closeError);
          }
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [libraryRetry, player]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') return;
      const { db: activeDb, book, position, isLoaded } = playbackSnapshot.current;
      if (!activeDb || !book || !isLoaded) return;
      const updated = { ...book, position };
      void saveBook(activeDb, updated).catch((saveError: unknown) => {
        console.error('Could not save playback progress when leaving the app', saveError);
        setError(`Could not save playback progress: ${errorMessage(saveError)}`);
      });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch((audioError: unknown) => {
      console.error('Could not enable background audio playback', audioError);
      setError(`Audio setup failed: ${errorMessage(audioError)}`);
    });
  }, []);

  useEffect(() => {
    if (!db || !currentBook || !status.isLoaded || status.duration <= 0) return;
    if (currentBook.duration === status.duration) return;
    const updated = { ...currentBook, duration: status.duration };
    setBooks((items) => items.map((book) => book.id === updated.id ? updated : book));
    void saveBook(db, updated).catch((saveError: unknown) => {
      console.error('Could not save audiobook duration', saveError);
      setError(`Could not save audiobook details: ${errorMessage(saveError)}`);
    });
  }, [currentBook, db, status.duration, status.isLoaded]);

  useEffect(() => {
    if (!db || !currentBook || !status.isLoaded) return;
    const now = Date.now();
    if (now - lastSavedAt.current < 10000) return;
    lastSavedAt.current = now;
    const updated = { ...currentBook, position: status.currentTime };
    setBooks((items) => items.map((book) => book.id === updated.id ? updated : book));
    void saveBook(db, updated).catch((saveError: unknown) => {
      console.error('Could not save audiobook progress', saveError);
      setError(`Could not save playback progress: ${errorMessage(saveError)}`);
    });
  }, [currentBook, db, status.currentTime, status.isLoaded]);

  useEffect(() => {
    if (!currentId || !status.isLoaded || pendingSeek.current === null) return;
    const position = pendingSeek.current;
    pendingSeek.current = null;
    void player.seekTo(position).catch((seekError: unknown) => {
      console.error('Could not restore audiobook position', seekError);
      setError(`Could not restore playback position: ${errorMessage(seekError)}`);
    });
  }, [currentId, player, status.isLoaded]);

  useEffect(() => {
    if (!status.error) return;
    console.error('Audiobook playback failed', status.error);
    setError(`Playback failed: ${status.error}`);
  }, [status.error]);

  useEffect(() => {
    if (!status.didJustFinish) {
      handledFinish.current = false;
      return;
    }
    if (handledFinish.current) return;
    handledFinish.current = true;
    void saveProgress(status.duration).then(() => stepBook(1));
  }, [status.didJustFinish]);

  const visibleBooks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const pageBooks = books.filter((book) => {
      if (mode === 'recent') return book.lastPlayed > 0;
      if (mode === 'bookmarks') return book.bookmarks.length > 0;
      if (mode === 'queue') return queue.includes(book.id);
      return true;
    });
    const sorted = pageBooks.filter((book) =>
      !normalizedQuery || `${book.title} ${book.author}`.toLocaleLowerCase().includes(normalizedQuery),
    );
    if (mode === 'queue') {
      sorted.sort((a, b) => queueRank(queue, a.id) - queueRank(queue, b.id));
    } else if (mode === 'recent') {
      sorted.sort((a, b) => b.lastPlayed - a.lastPlayed || b.addedAt - a.addedAt);
    } else if (mode === 'bookmarks') {
      sorted.sort((a, b) => b.bookmarks.length - a.bookmarks.length || b.addedAt - a.addedAt);
    } else if (sort === 'title') {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === 'progress') {
      sorted.sort((a, b) => progressOf(b) - progressOf(a));
    } else {
      sorted.sort((a, b) => b.addedAt - a.addedAt);
    }
    return sorted;
  }, [books, mode, query, queue, sort]);

  async function persistQueue(nextQueue: string[]) {
    if (!db) return;
    try {
      await writeSetting(db, 'queue', nextQueue);
      setQueue(nextQueue);
    } catch (saveError) {
      console.error('Could not save playback queue', saveError);
      setError(`Could not save the playback queue: ${errorMessage(saveError)}`);
    }
  }

  async function addFiles() {
    if (!db || busy) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*',
        multiple: true,
        copyToCacheDirectory: false,
      });
      if (result.canceled) return;
      setBusy(true);
      const directory = new Directory(Paths.document, 'audiobooks');
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      const nextBooks = [...books];
      let added = 0;
      const failures: string[] = [];
      const metadataFailures: string[] = [];
      for (const asset of result.assets) {
        if (nextBooks.some((book) => book.sourceUri === asset.uri)) continue;
        const safeName = asset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
        const destination = new File(directory, `${makeId()}-${safeName}`);
        try {
          await new File(asset.uri).copy(destination);
          let book: Book = {
            id: makeId(),
            uri: destination.uri,
            sourceUri: asset.uri,
            title: titleFromName(asset.name),
            author: '',
            coverUri: null,
            duration: 0,
            position: 0,
            lastPlayed: 0,
            addedAt: Date.now(),
            bookmarks: [],
            chapters: [],
          };
          try {
            const metadata = await readAudioMetadata(destination.uri);
            let coverUri: string | null = null;
            if (metadata.coverData && metadata.coverExtension) {
              const coverDirectory = new Directory(Paths.document, 'covers');
              if (!coverDirectory.exists) coverDirectory.create({ intermediates: true, idempotent: true });
              const coverFile = new File(coverDirectory, `${makeId()}.${metadata.coverExtension}`);
              await coverFile.write(metadata.coverData);
              coverUri = coverFile.uri;
            }
            book = {
              ...book,
              title: metadata.title || book.title,
              author: metadata.author,
              duration: metadata.duration,
              chapters: metadata.chapters,
              coverUri,
            };
          } catch (metadataError) {
            console.error(`Could not read embedded metadata from ${asset.name}`, metadataError);
            metadataFailures.push(asset.name);
          }
          await saveBook(db, book);
          nextBooks.unshift(book);
          added += 1;
        } catch (copyError) {
          console.error(`Could not import ${asset.name}`, copyError);
          failures.push(`${asset.name}: ${errorMessage(copyError)}`);
        }
      }
      setBooks(nextBooks);
      setMode('all');
      setQuery('');
      const warnings = [
        ...failures.slice(0, 4).map((failure) => `Import failed: ${failure}`),
        ...metadataFailures.slice(0, 4).map((name) => `Embedded details unavailable: ${name}`),
      ];
      if (warnings.length) Alert.alert('Import completed with warnings', `${added} audiobook${added === 1 ? '' : 's'} added.\n\n${warnings.join('\n')}`);
      else if (!added) Alert.alert('Already in your library', 'The selected audio files are already imported.');
    } catch (pickerError) {
      console.error('Could not pick audiobook files', pickerError);
      setError(`Could not import audio files: ${errorMessage(pickerError)}`);
    } finally {
      setBusy(false);
    }
  }

  async function addCover() {
    if (!editBook || busy) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      const directory = new Directory(Paths.document, 'covers');
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
      const safeName = asset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
      const destination = new File(directory, `${makeId()}-${safeName}`);
      await new File(asset.uri).copy(destination);
      setEditBook({ ...editBook, coverUri: destination.uri });
    } catch (coverError) {
      console.error('Could not select cover artwork', coverError);
      setError(`Could not add cover artwork: ${errorMessage(coverError)}`);
    }
  }

  async function playBook(book: Book, startAt?: number) {
    if (currentId === book.id) {
      if (startAt !== undefined) {
        void player.seekTo(startAt);
        player.play();
      } else if (status.playing) player.pause();
      else player.play();
      return;
    }
    if (currentBook && status.isLoaded && db) {
      const previous = { ...currentBook, position: status.currentTime };
      await saveBook(db, previous);
      setBooks((items) => items.map((item) => item.id === previous.id ? previous : item));
    }
    try {
      setError(null);
      const startingPosition = startAt ?? book.position;
      pendingSeek.current = startingPosition > 0 ? startingPosition : null;
      setCurrentId(book.id);
      player.pause();
      player.replace({ uri: book.uri, name: book.title });
      player.play();
      const updated = { ...book, lastPlayed: Date.now() };
      setBooks((items) => items.map((item) => item.id === updated.id ? updated : item));
      if (db) {
        try {
          await saveBook(db, updated);
          await writeSetting(db, 'lastBookId', updated.id);
        } catch (saveError) {
          console.error(`Could not save ${updated.title} as the last played audiobook`, saveError);
          setError(`Playback started, but the last played audiobook could not be saved: ${errorMessage(saveError)}`);
        }
      }
      if (queue.includes(book.id)) await persistQueue(queue.filter((id) => id !== book.id));
      if (supportsNativePlaybackService) {
        player.setActiveForLockScreen(true, {
          title: book.title,
          artist: book.author || 'Audiobook',
          artworkUrl: book.coverUri ?? undefined,
        });
      }
    } catch (playError) {
      console.error(`Could not start ${book.title}`, playError);
      setError(`Could not play ${book.title}: ${errorMessage(playError)}`);
    }
  }

  async function stepBook(direction: number) {
    if (!books.length) return;
    if (direction > 0) {
      const queued = books.find((book) => queue.includes(book.id));
      if (queued) {
        await persistQueue(queue.filter((id) => id !== queued.id));
        await playBook(queued);
        return;
      }
    }
    const ordered = [...books].sort((a, b) => b.addedAt - a.addedAt);
    const index = ordered.findIndex((book) => book.id === currentId);
    await playBook(ordered[(index + direction + ordered.length) % ordered.length]);
  }

  function stepChapter(direction: number) {
    if (!currentBook?.chapters.length) {
      void stepBook(direction);
      return;
    }
    const index = chapterIndexAt(currentBook, status.currentTime);
    if (direction > 0) {
      if (index < currentBook.chapters.length - 1) {
        void player.seekTo(currentBook.chapters[Math.max(0, index + 1)].start);
        if (!status.playing) player.play();
      } else {
        void stepBook(1);
      }
      return;
    }
    const chapter = currentBook.chapters[index];
    if (chapter && status.currentTime > chapter.start + 3) {
      void player.seekTo(chapter.start);
      if (!status.playing) player.play();
    } else if (index > 0) {
      void player.seekTo(currentBook.chapters[index - 1].start);
      if (!status.playing) player.play();
    } else {
      void stepBook(-1);
    }
  }

  function selectChapter(book: Book, index: number) {
    const chapter = book.chapters[index];
    if (!chapter) return;
    setChaptersBook(null);
    void playBook(book, chapter.start);
  }

  async function saveEdits() {
    if (!db || !editBook) return;
    const updated = { ...editBook, title: editTitle.trim(), author: editAuthor.trim() };
    if (!updated.title) {
      Alert.alert('Add a title', 'An audiobook title cannot be empty.');
      return;
    }
    try {
      await saveBook(db, updated);
      setBooks((items) => items.map((book) => book.id === updated.id ? updated : book));
      setEditBook(null);
    } catch (saveError) {
      console.error('Could not save audiobook details', saveError);
      setError(`Could not save book details: ${errorMessage(saveError)}`);
    }
  }

  async function toggleQueue(book: Book) {
    const next = queue.includes(book.id)
      ? queue.filter((id) => id !== book.id)
      : [...queue, book.id];
    await persistQueue(next);
  }

  async function toggleBookmark(book: Book) {
    if (!db) return;
    const position = book.id === currentId ? status.currentTime : book.position;
    if (position <= 0) {
      Alert.alert('Nothing to bookmark yet', 'Start listening before saving a position.');
      return;
    }
    const bookmarks = book.bookmarks.some((value) => Math.abs(value - position) < 2)
      ? book.bookmarks.filter((value) => Math.abs(value - position) >= 2)
      : [...book.bookmarks, position].sort((a, b) => a - b);
    const updated = { ...book, bookmarks };
    try {
      await saveBook(db, updated);
      setBooks((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (saveError) {
      console.error('Could not save audiobook bookmark', saveError);
      setError(`Could not save bookmark: ${errorMessage(saveError)}`);
    }
  }

  async function removeBook(book: Book) {
    if (!db) return;
    Alert.alert(
      'Remove audiobook?',
      `${book.title} will be removed from your library. Its audio file will remain on this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await db.runAsync('DELETE FROM books WHERE id = ?', book.id);
                setBooks((items) => items.filter((item) => item.id !== book.id));
                await persistQueue(queue.filter((id) => id !== book.id));
                if (currentId === book.id) {
                  player.pause();
                  player.replace(null);
                  if (supportsNativePlaybackService) player.clearLockScreenControls();
                  setCurrentId(null);
                  await writeSetting(db, 'lastBookId', null);
                }
              } catch (removeError) {
                console.error('Could not remove audiobook', removeError);
                setError(`Could not remove audiobook: ${errorMessage(removeError)}`);
              }
            })();
          },
        },
      ],
    );
  }

  async function changeSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    player.setPlaybackRate(next);
    if (!db) return;
    try {
      await writeSetting(db, 'settings', { speed: next });
    } catch (saveError) {
      console.error('Could not save playback speed', saveError);
      setError(`Could not save playback speed: ${errorMessage(saveError)}`);
    }
  }

  async function saveProgress(position = status.currentTime) {
    if (!db || !currentBook || !status.isLoaded) return;
    const updated = { ...currentBook, position };
    try {
      await saveBook(db, updated);
      setBooks((items) => items.map((book) => book.id === updated.id ? updated : book));
    } catch (saveError) {
      console.error('Could not save playback position', saveError);
      setError(`Could not save playback position: ${errorMessage(saveError)}`);
    }
  }

  const activeChapterIndex = currentBook ? chapterIndexAt(currentBook, status.currentTime) : -1;
  const activeChapter = activeChapterIndex >= 0 ? currentBook?.chapters[activeChapterIndex] : null;
  const navItems: { key: ViewMode; label: string }[] = [
    { key: 'all', label: 'Library' },
    { key: 'recent', label: 'Recent' },
    { key: 'bookmarks', label: 'Bookmarks' },
    { key: 'queue', label: `Queue${queue.length ? ` · ${queue.length}` : ''}` },
  ];

  if (loading) {
    return (
      <View style={styles.loading}>
        <StatusBar style="light" />
        <ActivityIndicator color={COLORS[0]} size="large" />
        <Text style={styles.muted}>Opening your local library…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.topBar}>
        <View>
          <Text style={styles.brand}>STORY<Text style={styles.brandAccent}>ROOM</Text></Text>
          <Text style={styles.kicker}>YOUR PERSONAL AUDIOBOOKS</Text>
        </View>
        <Pressable onPress={() => void addFiles()} style={styles.addButton} disabled={busy}>
          {busy ? <ActivityIndicator color={COLORS[0]} /> : <Text style={styles.addButtonText}>＋ Add</Text>}
        </Pressable>
      </View>
      <View style={styles.nav}>
        {navItems.map((item) => (
          <Pressable
            key={item.key}
            onPress={() => setMode(item.key)}
            accessibilityRole="button"
            accessibilityLabel={item.key === 'bookmarks' ? 'Bookmarks' : item.label}
            accessibilityState={{ selected: mode === item.key }}
            style={[styles.navItem, mode === item.key && styles.navItemActive]}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
              style={[styles.navText, mode === item.key && styles.navTextActive]}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {!supportsNativePlaybackService ? (
        <View style={styles.runtimeNotice}>
          <Text style={styles.runtimeNoticeText}>
            Expo Go supports playback while open. Install a Storyroom development build for background and lock-screen playback.
          </Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
          {!db ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setError(null);
                setLoading(true);
                setLibraryRetry((attempt) => attempt + 1);
              }}
            >
              <Text style={styles.errorRetry}>Retry</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityLabel="Dismiss error" onPress={() => setError(null)}><Text style={styles.errorDismiss}>×</Text></Pressable>
        </View>
      ) : null}

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {mode === 'all' ? (
          <View style={styles.hero}>
            <Text style={styles.heroEyebrow}>MAKE TIME FOR A GOOD STORY</Text>
            <Text style={styles.heroTitle}>Less scrolling.{'\n'}<Text style={styles.heroItalic}>More stories.</Text></Text>
            <Text style={styles.heroCaption}>Your books, your pace. Pick up where you left off.</Text>
            <View style={styles.heroDecoration}><Text style={styles.heroGlyph}>✳</Text></View>
          </View>
        ) : (
          <View style={styles.pageHeader}>
            <Text style={styles.pageEyebrow}>YOUR STORYROOM</Text>
            <View style={styles.pageTitleRow}>
              <Text style={styles.pageTitle}>{modeLabel(mode)}</Text>
              <Text style={styles.count}>{visibleBooks.length}</Text>
            </View>
            <Text style={styles.pageDescription}>
              {mode === 'recent' && 'Pick up where you left off.'}
              {mode === 'bookmarks' && 'Your saved listening moments.'}
              {mode === 'queue' && 'Audiobooks lined up to play next.'}
            </Text>
          </View>
        )}

        <View style={styles.libraryHeading}>
          {mode === 'all' ? (
            <View style={styles.headingRow}>
              <Text style={styles.sectionTitle}>Your library</Text>
              <Text style={styles.count}>{visibleBooks.length}</Text>
            </View>
          ) : null}
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search your books"
            placeholderTextColor="#7e8479"
            accessibilityLabel="Search audiobooks"
            style={styles.search}
          />
          {mode === 'all' ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sortRow}>
              {(['added', 'title', 'progress'] as SortMode[]).map((item) => (
                <Pressable key={item} onPress={() => setSort(item)} style={[styles.filterChip, sort === item && styles.filterChipActive]}>
                  <Text style={[styles.filterText, sort === item && styles.filterTextActive]}>
                    {item === 'added' ? 'Recently added' : item === 'title' ? 'Title A–Z' : 'Most progress'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>

        {visibleBooks.length ? visibleBooks.map((book, index) => (
          <BookCard
            key={book.id}
            book={book}
            color={COLORS[index % COLORS.length]}
            queued={queue.includes(book.id)}
            active={book.id === currentId}
            onPlay={() => void playBook(book)}
            onQueue={() => void toggleQueue(book)}
            onBookmark={() => void toggleBookmark(book)}
            onChapters={() => setChaptersBook(book)}
            onEdit={() => { setEditBook(book); setEditTitle(book.title); setEditAuthor(book.author); }}
            onRemove={() => void removeBook(book)}
          />
        )) : (
          <View style={styles.empty}>
            <Text style={styles.emptyGlyph}>♫</Text>
            <Text style={styles.emptyTitle}>{emptyTitle(mode, books.length, query)}</Text>
            <Text style={styles.emptyBody}>{emptyDescription(mode, books.length, query)}</Text>
            {mode === 'all' && books.length === 0 && <Pressable style={styles.emptyButton} onPress={() => void addFiles()}><Text style={styles.emptyButtonText}>Import audio files</Text></Pressable>}
          </View>
        )}
      </ScrollView>

      <View style={styles.player}>
        <View style={styles.nowPlaying}>
          <Cover book={currentBook} color={COLORS[0]} size={42} />
          <View style={styles.nowMeta}>
            <Text numberOfLines={1} style={styles.nowTitle}>{currentBook?.title ?? 'Choose a book to begin'}</Text>
            <Text numberOfLines={1} style={styles.nowAuthor}>{currentBook?.author || (currentBook ? 'Local audio file' : 'Ready when you are')}</Text>
            {activeChapter ? <Text numberOfLines={1} style={styles.nowChapter}>{activeChapter.title}</Text> : null}
          </View>
          {currentBook?.chapters.length ? (
            <Pressable onPress={() => setChaptersBook(currentBook)} style={styles.chaptersButton}>
              <Text style={styles.chaptersButtonText}>{currentBook.chapters.length} ch.</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => void changeSpeed()} style={styles.speedButton}><Text style={styles.speedText}>{speed}×</Text></Pressable>
        </View>
        <View style={styles.timeline}>
          <Text style={styles.time}>{formatTime(status.currentTime)}</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={Math.max(status.duration, 1)}
            value={Math.min(status.currentTime, status.duration || 1)}
            minimumTrackTintColor={COLORS[0]}
            maximumTrackTintColor="#42483d"
            thumbTintColor={COLORS[0]}
            onSlidingComplete={(value) => { void player.seekTo(value); void saveProgress(value); }}
            disabled={!currentBook || !status.isLoaded}
            accessibilityLabel="Playback position"
          />
          <Text style={styles.time}>{formatTime(status.duration)}</Text>
        </View>
        <View style={styles.controls}>
          <Pressable onPress={() => { void player.seekTo(Math.max(0, status.currentTime - 30)); }} style={styles.skipButton}><Text style={styles.skipText}>↶30</Text></Pressable>
          <Pressable onPress={() => stepChapter(-1)} style={styles.controlButton}><Text style={styles.controlText}>|◂</Text></Pressable>
          <Pressable
            onPress={() => {
              if (!currentBook) return;
              if (status.playing) { player.pause(); void saveProgress(); }
              else player.play();
            }}
            style={styles.playButton}
            accessibilityLabel={status.playing ? 'Pause' : 'Play'}
          >
            <Text style={styles.playGlyph}>{status.playing ? 'Ⅱ' : '▶'}</Text>
          </Pressable>
          <Pressable onPress={() => stepChapter(1)} style={styles.controlButton}><Text style={styles.controlText}>▸|</Text></Pressable>
          <Pressable onPress={() => { void player.seekTo(Math.min(status.duration || Infinity, status.currentTime + 30)); }} style={styles.skipButton}><Text style={styles.skipText}>↷30</Text></Pressable>
        </View>
      </View>

      <Modal visible={!!editBook} transparent animationType="slide" onRequestClose={() => setEditBook(null)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.editSheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeading}>
              <View><Text style={styles.sheetEyebrow}>BOOK DETAILS</Text><Text style={styles.sheetTitle}>Edit audiobook</Text></View>
              <Pressable onPress={() => setEditBook(null)}><Text style={styles.closeButton}>×</Text></Pressable>
            </View>
            <Text style={styles.fieldLabel}>Title</Text>
            <TextInput style={styles.field} value={editTitle} onChangeText={setEditTitle} maxLength={180} />
            <Text style={styles.fieldLabel}>Author / narrator</Text>
            <TextInput style={styles.field} value={editAuthor} onChangeText={setEditAuthor} maxLength={180} />
            {editBook?.coverUri ? <Image source={{ uri: editBook.coverUri }} style={styles.coverPreview} /> : null}
            <Pressable onPress={() => void addCover()} style={styles.outlineButton}><Text style={styles.outlineButtonText}>Choose cover artwork</Text></Pressable>
            <Pressable onPress={() => void saveEdits()} style={styles.saveButton}><Text style={styles.saveButtonText}>Save changes</Text></Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!chaptersBook} transparent animationType="slide" onRequestClose={() => setChaptersBook(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.editSheet, styles.chapterSheet]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeading}>
              <View><Text style={styles.sheetEyebrow}>AUDIOBOOK CONTENTS</Text><Text numberOfLines={1} style={styles.sheetTitle}>{chaptersBook?.title}</Text></View>
              <Pressable onPress={() => setChaptersBook(null)}><Text style={styles.closeButton}>×</Text></Pressable>
            </View>
            <ScrollView>
              {chaptersBook?.chapters.map((chapter, index) => (
                <Pressable
                  key={`${chapter.start}-${index}`}
                  onPress={() => selectChapter(chaptersBook, index)}
                  style={[styles.chapterRow, chaptersBook.id === currentId && index === activeChapterIndex && styles.chapterRowActive]}
                >
                  <Text numberOfLines={2} style={styles.chapterTitle}>{chapter.title}</Text>
                  <Text style={styles.chapterTime}>{formatTime(chapter.start)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function BookCard({
  book, color, queued, active, onPlay, onQueue, onBookmark, onChapters, onEdit, onRemove,
}: {
  book: Book;
  color: string;
  queued: boolean;
  active: boolean;
  onPlay: () => void;
  onQueue: () => void;
  onBookmark: () => void;
  onChapters: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const progress = progressOf(book);
  return (
    <View style={[styles.bookCard, active && styles.bookCardActive]}>
      <Pressable onPress={onPlay} accessibilityLabel={`Play ${book.title}`}><Cover book={book} color={color} size={84} /></Pressable>
      <View style={styles.bookInfo}>
        <Text numberOfLines={2} style={styles.bookTitle}>{book.title}</Text>
        <Text numberOfLines={1} style={styles.bookAuthor}>{book.author || 'Local audio file'}</Text>
        <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress * 100}%` }]} /></View>
        <Text style={styles.bookStatus}>{active ? 'NOW PLAYING' : progress > 0 ? 'IN PROGRESS' : 'NOT STARTED'}{book.duration ? ` · ${formatTime(book.duration)}` : ''}</Text>
        <View style={styles.cardActions}>
          <SmallAction label={queued ? '✓ Queued' : '＋ Queue'} onPress={onQueue} />
          <SmallAction label={book.bookmarks.length ? `⚑ ${book.bookmarks.length}` : '⚑ Mark'} onPress={onBookmark} />
          {book.chapters.length ? <SmallAction label={`Chapters · ${book.chapters.length}`} onPress={onChapters} /> : null}
          <SmallAction label="Edit" onPress={onEdit} />
          <SmallAction label="Remove" onPress={onRemove} destructive />
        </View>
      </View>
    </View>
  );
}

function Cover({ book, color, size }: { book: Book | null; color: string; size: number }) {
  if (book?.coverUri) return <Image source={{ uri: book.coverUri }} style={[styles.cover, { width: size, height: size + 22 }]} />;
  return (
    <View style={[styles.cover, styles.coverPlaceholder, { width: size, height: size + 22, backgroundColor: color }]}>
      <Text style={[styles.coverSymbol, { fontSize: Math.max(20, size * 0.35) }]}>{book ? book.title.slice(0, 1).toUpperCase() : '♫'}</Text>
      {size > 70 ? <Text style={styles.coverBrand}>STORYROOM · AUDIO</Text> : null}
    </View>
  );
}

function SmallAction({ label, onPress, destructive = false }: { label: string; onPress: () => void; destructive?: boolean }) {
  return <Pressable onPress={onPress} style={styles.smallAction}><Text style={[styles.smallActionText, destructive && styles.destructiveText]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#161a16', paddingTop: Platform.OS === 'android' ? (NativeStatusBar.currentHeight ?? 0) : 0 },
  loading: { flex: 1, backgroundColor: '#161a16', alignItems: 'center', justifyContent: 'center', gap: 14 },
  topBar: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { color: '#f2eddf', letterSpacing: 1.7, fontSize: 18, fontWeight: '900' },
  brandAccent: { color: '#a6b785' },
  kicker: { color: '#7b8275', fontSize: 9, letterSpacing: 1.4, marginTop: 3 },
  addButton: { backgroundColor: '#a6b785', borderRadius: 13, paddingHorizontal: 16, paddingVertical: 11, minWidth: 82, alignItems: 'center' },
  addButtonText: { color: '#1c2419', fontSize: 14, fontWeight: '800' },
  nav: { flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 14, gap: 6 },
  navItem: { flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 20, borderWidth: 1, borderColor: '#333a31', paddingHorizontal: 4, paddingVertical: 9 },
  navItemActive: { borderColor: '#a6b785', backgroundColor: '#323b2c' },
  navText: { color: '#a8ad9f', fontSize: 11, fontWeight: '600', textAlign: 'center' },
  navTextActive: { color: '#dce7c8' },
  runtimeNotice: { marginHorizontal: 16, marginBottom: 10, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: '#30382b' },
  runtimeNoticeText: { color: '#c7d3b6', fontSize: 11, lineHeight: 16 },
  errorBanner: { marginHorizontal: 16, marginBottom: 10, padding: 12, backgroundColor: '#482d2b', borderRadius: 12, flexDirection: 'row', alignItems: 'center' },
  errorText: { flex: 1, color: '#ffd5c9', fontSize: 12 },
  errorRetry: { color: '#f2eddf', fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 6 },
  errorDismiss: { color: '#ffd5c9', fontSize: 22, paddingHorizontal: 6 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 22 },
  hero: { backgroundColor: '#242c22', borderRadius: 22, paddingHorizontal: 20, paddingVertical: 21, marginBottom: 25, overflow: 'hidden', minHeight: 172 },
  heroEyebrow: { color: '#a6b785', fontSize: 9, letterSpacing: 1.4, fontWeight: '800' },
  heroTitle: { color: '#f1eddf', fontSize: 29, lineHeight: 33, fontWeight: '700', marginTop: 12 },
  heroItalic: { color: '#c9d4b3', fontStyle: 'italic' },
  heroCaption: { color: '#a1a694', fontSize: 12, marginTop: 8 },
  heroDecoration: { position: 'absolute', right: -12, bottom: -36, width: 132, height: 145, borderRadius: 68, backgroundColor: '#3b4835', alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-12deg' }] },
  heroGlyph: { fontSize: 74, color: '#a6b785', opacity: 0.78 },
  pageHeader: { paddingTop: 10, paddingBottom: 20 },
  pageEyebrow: { color: '#a6b785', fontSize: 9, letterSpacing: 1.4, fontWeight: '800' },
  pageTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pageTitle: { color: '#f1eddf', fontSize: 21, lineHeight: 33, fontWeight: '700', marginTop: 0 },
  pageDescription: { color: '#a1a694', fontSize: 13, marginTop: 5 },
  libraryHeading: { marginBottom: 13 },
  headingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 9 },
  sectionTitle: { color: '#f2eddf', fontSize: 21, fontWeight: '700' },
  count: { color: '#b8c5a0', backgroundColor: '#30382b', overflow: 'hidden', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, fontSize: 12, includeFontPadding: false, textAlignVertical: 'center', transform: [{ translateY: 1 }] },
  search: { backgroundColor: '#232822', borderColor: '#343b32', borderWidth: 1, borderRadius: 13, paddingHorizontal: 15, paddingVertical: 11, color: '#eee9dd', fontSize: 14 },
  sortRow: { gap: 8, paddingVertical: 11 },
  filterChip: { borderWidth: 1, borderColor: '#343b32', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16 },
  filterChipActive: { borderColor: '#76865c', backgroundColor: '#30382b' },
  filterText: { color: '#909789', fontSize: 11 },
  filterTextActive: { color: '#d7e2c3' },
  bookCard: { backgroundColor: '#20251f', borderColor: '#30372e', borderWidth: 1, borderRadius: 17, padding: 11, flexDirection: 'row', gap: 13, marginBottom: 11 },
  bookCardActive: { borderColor: '#809365' },
  cover: { borderRadius: 10, overflow: 'hidden' },
  coverPlaceholder: { alignItems: 'center', justifyContent: 'center', padding: 6 },
  coverSymbol: { color: '#f3eddb', fontWeight: '800' },
  coverBrand: { position: 'absolute', bottom: 5, color: '#eee7d4', fontSize: 6, letterSpacing: 0.5 },
  bookInfo: { flex: 1, justifyContent: 'center' },
  bookTitle: { color: '#f2eddf', fontWeight: '700', fontSize: 15, lineHeight: 19 },
  bookAuthor: { color: '#969d8f', fontSize: 12, marginTop: 4 },
  progressTrack: { height: 3, borderRadius: 2, backgroundColor: '#42483e', marginTop: 11, overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: '#a6b785' },
  bookStatus: { color: '#858d7d', fontSize: 8, letterSpacing: 0.6, marginTop: 5 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  smallAction: { borderRadius: 7, borderWidth: 1, borderColor: '#373e34', paddingHorizontal: 7, paddingVertical: 5 },
  smallActionText: { color: '#b6bcae', fontSize: 9 },
  destructiveText: { color: '#ce8d82' },
  empty: { alignItems: 'center', paddingHorizontal: 25, paddingTop: 38, paddingBottom: 42 },
  emptyGlyph: { color: '#a6b785', fontSize: 40 },
  emptyTitle: { color: '#efeadd', fontSize: 18, fontWeight: '700', marginTop: 10 },
  emptyBody: { color: '#9ba193', fontSize: 13, textAlign: 'center', lineHeight: 19, marginTop: 8 },
  emptyButton: { marginTop: 17, backgroundColor: '#a6b785', borderRadius: 11, paddingHorizontal: 17, paddingVertical: 11 },
  emptyButtonText: { color: '#1c2419', fontWeight: '800' },
  player: { backgroundColor: '#20251f', borderTopWidth: 1, borderColor: '#353d32', paddingTop: 9, paddingBottom: Platform.OS === 'android' ? 25 : 18, paddingHorizontal: 14 },
  nowPlaying: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  nowMeta: { flex: 1 },
  nowTitle: { color: '#f2eddf', fontWeight: '700', fontSize: 13 },
  nowAuthor: { color: '#969d8f', fontSize: 11, marginTop: 3 },
  nowChapter: { color: '#b8c5a0', fontSize: 10, marginTop: 2 },
  chaptersButton: { borderWidth: 1, borderColor: '#46503e', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 7 },
  chaptersButtonText: { color: '#c6d2b1', fontSize: 10, fontWeight: '700' },
  speedButton: { borderWidth: 1, borderColor: '#46503e', borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7 },
  speedText: { color: '#c6d2b1', fontSize: 12, fontWeight: '700' },
  timeline: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5 },
  time: { color: '#909789', fontSize: 9, width: 36, textAlign: 'center' },
  slider: { flex: 1, height: 22 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 23, marginTop: 1 },
  skipButton: { padding: 5 },
  skipText: { color: '#9ea592', fontSize: 12, fontWeight: '600' },
  controlButton: { padding: 7 },
  controlText: { color: '#c7ceba', fontSize: 17, fontWeight: '700' },
  playButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#a6b785', alignItems: 'center', justifyContent: 'center' },
  playGlyph: { color: '#20271b', fontSize: 17, fontWeight: '900' },
  muted: { color: '#a4aa9c' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0009' },
  editSheet: { backgroundColor: '#222821', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 22, paddingTop: 12, paddingBottom: Platform.OS === 'android' ? 28 : 38 },
  sheetHandle: { width: 38, height: 4, borderRadius: 2, backgroundColor: '#68705f', alignSelf: 'center', marginBottom: 19 },
  sheetHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  sheetEyebrow: { color: '#a6b785', fontSize: 9, letterSpacing: 1.4, fontWeight: '800' },
  sheetTitle: { color: '#f2eddf', fontWeight: '700', fontSize: 21, marginTop: 4 },
  closeButton: { color: '#9fa695', fontSize: 30, paddingHorizontal: 4 },
  chapterSheet: { maxHeight: '78%' },
  chapterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, borderBottomWidth: 1, borderBottomColor: '#343b32', paddingVertical: 13, paddingHorizontal: 5 },
  chapterRowActive: { backgroundColor: '#30382b' },
  chapterTitle: { flex: 1, color: '#e7e5d8', fontSize: 13 },
  chapterTime: { color: '#9ca58d', fontSize: 11 },
  fieldLabel: { color: '#c7cbbb', fontSize: 12, fontWeight: '600', marginBottom: 7, marginTop: 10 },
  field: { backgroundColor: '#171c17', color: '#f2eddf', borderColor: '#3b4436', borderWidth: 1, borderRadius: 11, paddingHorizontal: 13, paddingVertical: 12, fontSize: 14 },
  coverPreview: { width: 70, height: 90, borderRadius: 9, marginTop: 12 },
  outlineButton: { borderColor: '#788661', borderWidth: 1, borderRadius: 11, alignItems: 'center', paddingVertical: 12, marginTop: 15 },
  outlineButtonText: { color: '#d5dfc3', fontWeight: '600' },
  saveButton: { backgroundColor: '#a6b785', borderRadius: 11, alignItems: 'center', paddingVertical: 13, marginTop: 10 },
  saveButtonText: { color: '#20271b', fontWeight: '800' },
});
