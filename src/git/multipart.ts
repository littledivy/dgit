import { concat } from "./util";

/** In-progress R2 multipart upload for one pack object (clone cache or raw store). */
export interface MultipartPackUpload {
  uploadPart(data: Uint8Array): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

/** Uniform multipart part size. R2 requires every part but the last to be the
 * same size and >= 5 MiB; 16 MiB parts cap a pack at 16 MiB * 10,000 = 160 GiB
 * while holding at most one part in isolate memory at a time. */
export const R2_PART_SIZE = 16 * 1024 * 1024;

/**
 * Buffers a streamed pack into fixed-size R2 multipart parts. Chunks are copied
 * on push (callers hand out views into buffers that later reads evict). `drain`
 * uploads every whole 16 MiB part and keeps the sub-part remainder, so isolate
 * memory never holds more than ~one part; `finish` flushes the final (short)
 * part and completes; any failure aborts so R2 is left with no partial object.
 * Uniform part size (exactly R2_PART_SIZE, last excepted) is what satisfies R2's
 * equal-size-parts rule.
 */
export class MultipartCapture {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private failed = false;
  private completed = false;
  constructor(private mp: MultipartPackUpload) {}

  /** True once a part upload or complete/abort has failed (no R2 object exists). */
  get aborted(): boolean {
    return this.failed;
  }

  push(chunk: Uint8Array): void {
    if (this.failed) return;
    this.chunks.push(chunk.slice());
    this.len += chunk.length;
  }

  async drain(): Promise<void> {
    while (!this.failed && this.len >= R2_PART_SIZE) {
      const merged = concat(this.chunks);
      try {
        await this.mp.uploadPart(merged.subarray(0, R2_PART_SIZE));
      } catch {
        await this.abort();
        return;
      }
      const rest = merged.slice(R2_PART_SIZE);
      this.chunks = rest.length ? [rest] : [];
      this.len = rest.length;
    }
  }

  async finish(): Promise<void> {
    if (this.failed) return;
    try {
      if (this.len) await this.mp.uploadPart(concat(this.chunks));
      await this.mp.complete();
      this.completed = true;
    } catch {
      await this.abort();
    }
    this.chunks = [];
    this.len = 0;
  }

  async abort(): Promise<void> {
    if (this.failed || this.completed) return;
    this.failed = true;
    this.chunks = [];
    this.len = 0;
    try {
      await this.mp.abort();
    } catch {
      // best effort: an un-aborted multipart auto-expires
    }
  }
}

/** Begin a raw R2 multipart upload under `key`. Returns null (caller falls back)
 * if R2 refuses — celld deliberately makes createMultipartUpload throw. */
export async function beginRawMultipart(
  bucket: R2Bucket,
  key: string
): Promise<MultipartPackUpload | null> {
  try {
    const mp = await bucket.createMultipartUpload(key);
    const parts: R2UploadedPart[] = [];
    return {
      uploadPart: async (data) => {
        parts.push(await mp.uploadPart(parts.length + 1, data));
      },
      complete: async () => {
        await mp.complete(parts);
      },
      abort: async () => {
        await mp.abort();
      },
    };
  } catch {
    return null;
  }
}
