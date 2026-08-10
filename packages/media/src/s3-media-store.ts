import { createHash, randomUUID } from "node:crypto";

import type { MediaObject, MediaPutInput, MediaStore } from "./types.js";

export interface S3ObjectClient {
  putObject(input: {
    key: string;
    body: ReadableStream<Uint8Array>;
    contentType: string;
  }): Promise<void>;
  getObject(key: string): Promise<ReadableStream<Uint8Array>>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
}

/**
 * S3-compatible MediaStore boundary. Deployment-specific signing, endpoint,
 * region, and credential handling stay inside the injected object client.
 */
export class S3MediaStore implements MediaStore {
  constructor(
    private readonly client: S3ObjectClient,
    private readonly prefix = "meet",
  ) {}

  async put(input: MediaPutInput): Promise<MediaObject> {
    const key = `${this.prefix.replace(/^\/+|\/+$/g, "")}/${randomUUID()}`;
    const source = toStream(input.body);
    const [upload, digest] = source.tee();
    const measurement = measure(digest);
    await Promise.all([
      this.client.putObject({
        key,
        body: upload,
        contentType: input.contentType,
      }),
      measurement,
    ]);
    const result = await measurement;
    return { key, ...result };
  }

  open(key: string): Promise<ReadableStream<Uint8Array>> {
    return this.client.getObject(key);
  }

  delete(key: string): Promise<void> {
    return this.client.deleteObject(key);
  }

  exists(key: string): Promise<boolean> {
    return this.client.objectExists(key);
  }
}

function toStream(body: MediaPutInput["body"]): ReadableStream<Uint8Array> {
  if (!(body instanceof Uint8Array)) return body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
}

async function measure(stream: ReadableStream<Uint8Array>): Promise<{
  sizeBytes: number;
  checksumSha256: string;
}> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of stream) {
    sizeBytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { sizeBytes, checksumSha256: hash.digest("hex") };
}
