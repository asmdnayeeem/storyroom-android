import { parseFromTokenizer, selectCover } from 'music-metadata';
import { File, FileMode, type FileHandle } from 'expo-file-system';
import {
  AbstractTokenizer,
  EndOfStreamError,
  type IRandomAccessFileInfo,
  type IReadChunkOptions,
} from 'strtok3';
import { Chapter } from './library';

const MAX_METADATA_BUFFER_SIZE = 16 * 1024 * 1024;

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export type AudioMetadata = {
  title: string;
  author: string;
  duration: number;
  chapters: Chapter[];
  coverData: Uint8Array | null;
  coverExtension: string | null;
};

class ExpoFileTokenizer extends AbstractTokenizer {
  readonly fileInfo: IRandomAccessFileInfo;

  constructor(
    private readonly handle: FileHandle,
    size: number,
    uri: string,
  ) {
    super({ maxBufferSize: MAX_METADATA_BUFFER_SIZE });
    this.fileInfo = { size, url: uri };
  }

  async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const normalized = this.normalizeOptions(buffer, options);
    const count = await this.readAt(buffer, normalized.position, normalized.length);
    this.position = normalized.position + count;
    if (count < normalized.length && !normalized.mayBeLess) throw new EndOfStreamError();
    return count;
  }

  async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const normalized = this.normalizeOptions(buffer, options);
    const count = await this.readAt(buffer, normalized.position, normalized.length);
    if (count < normalized.length && !normalized.mayBeLess) throw new EndOfStreamError();
    return count;
  }

  async ignore(length: number): Promise<number> {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Ignore length must be a non-negative safe integer.');
    const count = Math.min(length, this.fileInfo.size - this.position);
    this.position += count;
    return count;
  }

  async close(): Promise<void> {
    this.handle.close();
    await super.close();
  }

  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  private async readAt(buffer: Uint8Array, position: number, length: number): Promise<number> {
    if (!Number.isSafeInteger(position) || position < 0) throw new RangeError('File offset must be a non-negative safe integer.');
    const available = Math.max(0, Math.min(length, this.fileInfo.size - position));
    if (available === 0) return 0;
    this.handle.offset = position;
    const bytes = this.handle.readBytes(available);
    buffer.set(bytes, 0);
    return bytes.length;
  }
}

export async function readAudioMetadata(uri: string): Promise<AudioMetadata> {
  const file = new File(uri);
  const size = file.size;
  if (size === null) throw new Error(`Could not determine audio file size: ${file.name}`);
  const tokenizer = new ExpoFileTokenizer(file.open(FileMode.ReadOnly), size, uri);
  let metadata;
  try {
    metadata = await parseFromTokenizer(tokenizer, { includeChapters: true });
  } finally {
    await tokenizer.close();
  }
  const sourceChapters = metadata.format.chapters ?? [];
  const chapters = sourceChapters
    .map((chapter, index) => ({
      title: chapter.title?.trim() || `Chapter ${index + 1}`,
      start: chapter.start / (chapter.timeScale || 1),
    }))
    .filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0)
    .sort((first, second) => first.start - second.start);
  const picture = metadata.common.picture?.find((item) =>
    IMAGE_EXTENSIONS[item.format.toLowerCase()] && item.data.length <= 16 * 1024 * 1024,
  ) ?? selectCover(metadata.common.picture);
  const coverExtension = picture ? IMAGE_EXTENSIONS[picture.format.toLowerCase()] : null;

  return {
    title: metadata.common.title?.trim() || '',
    author: metadata.common.artist?.trim() || metadata.common.albumartist?.trim() || '',
    duration: Number.isFinite(metadata.format.duration) ? metadata.format.duration ?? 0 : 0,
    chapters,
    coverData: picture && coverExtension && picture.data.length <= 16 * 1024 * 1024
      ? picture.data
      : null,
    coverExtension,
  };
}
