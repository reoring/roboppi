const DEFAULT_MAX_LINES = 5000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2MB

export interface RingBufferOptions {
  maxLines: number;
  maxBytes?: number;
}

export class RingBuffer<T extends string> {
  private buf: T[] = [];
  private _totalBytes = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  constructor(opts?: Partial<RingBufferOptions>) {
    this.maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  push(item: T): void {
    const itemBytes = item.length;

    // Add the item first
    this.buf.push(item);
    this._totalBytes += itemBytes;

    // Evict oldest to satisfy maxLines
    while (this.buf.length > this.maxLines) {
      const evicted = this.buf.shift()!;
      this._totalBytes -= evicted.length;
    }

    // Evict oldest to satisfy maxBytes
    while (this._totalBytes > this.maxBytes && this.buf.length > 0) {
      const evicted = this.buf.shift()!;
      this._totalBytes -= evicted.length;
    }
  }

  lines(): T[] {
    return this.buf.slice();
  }

  get length(): number {
    return this.buf.length;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }

  clear(): void {
    this.buf = [];
    this._totalBytes = 0;
  }
}
