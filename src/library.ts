import * as SQLite from 'expo-sqlite';

export type Chapter = {
  title: string;
  start: number;
};

export type Book = {
  id: string;
  uri: string;
  sourceUri: string;
  title: string;
  author: string;
  coverUri: string | null;
  duration: number;
  position: number;
  lastPlayed: number;
  addedAt: number;
  bookmarks: number[];
  chapters: Chapter[];
};

type BookRow = {
  id: string;
  uri: string;
  source_uri: string;
  title: string;
  author: string;
  cover_uri: string | null;
  duration: number;
  position: number;
  last_played: number;
  added_at: number;
  bookmarks: string;
  chapters: string;
};

export async function openLibrary(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('storyroom.db', { useNewConnection: true });
  try {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY NOT NULL,
        uri TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        cover_uri TEXT,
        duration REAL NOT NULL DEFAULT 0,
        position REAL NOT NULL DEFAULT 0,
        last_played INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        bookmarks TEXT NOT NULL DEFAULT '[]',
        chapters TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    return db;
  } catch (error) {
    try {
      await db.closeAsync();
    } catch (closeError) {
      console.error('Could not close the database after initialization failed', closeError);
    }
    throw error;
  }
}

export async function readBooks(db: SQLite.SQLiteDatabase): Promise<Book[]> {
  const rows = await db.getAllAsync<BookRow>('SELECT * FROM books ORDER BY added_at DESC');
  return rows.map((row) => ({
    id: row.id,
    uri: row.uri,
    sourceUri: row.source_uri,
    title: row.title,
    author: row.author,
    coverUri: row.cover_uri,
    duration: row.duration,
    position: row.position,
    lastPlayed: row.last_played,
    addedAt: row.added_at,
    bookmarks: parseJson<number[]>(row.bookmarks, []),
    chapters: parseJson<Chapter[]>(row.chapters, []),
  }));
}

export async function saveBook(db: SQLite.SQLiteDatabase, book: Book): Promise<void> {
  await db.runAsync(
    `INSERT INTO books (
      id, uri, source_uri, title, author, cover_uri, duration, position,
      last_played, added_at, bookmarks, chapters
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      uri = excluded.uri,
      source_uri = excluded.source_uri,
      title = excluded.title,
      author = excluded.author,
      cover_uri = excluded.cover_uri,
      duration = excluded.duration,
      position = excluded.position,
      last_played = excluded.last_played,
      added_at = excluded.added_at,
      bookmarks = excluded.bookmarks,
      chapters = excluded.chapters`,
    book.id,
    book.uri,
    book.sourceUri,
    book.title,
    book.author,
    book.coverUri,
    book.duration,
    book.position,
    book.lastPlayed,
    book.addedAt,
    JSON.stringify(book.bookmarks),
    JSON.stringify(book.chapters),
  );
}

export async function readSetting<T>(
  db: SQLite.SQLiteDatabase,
  key: string,
  fallback: T,
): Promise<T> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    key,
  );
  return row ? parseJson<T>(row.value, fallback) : fallback;
}

export async function writeSetting(
  db: SQLite.SQLiteDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error('Could not decode stored audiobook data', error);
    return fallback;
  }
}
