import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  InvalidMediaObjectKeyError,
  MediaObjectNotFoundError,
  type MediaBody,
  type MediaObject,
  type MediaPutInput,
  type MediaStore,
} from "./types.js";

const OBJECT_KEY_PATTERN =
  /^\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class LocalMediaStore implements MediaStore {
  readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    if (!rootDirectory.trim()) {
      throw new TypeError("Media root directory must not be empty.");
    }
    this.rootDirectory = resolve(rootDirectory);
  }

  async put(input: MediaPutInput): Promise<MediaObject> {
    const key = createObjectKey();
    const target = this.resolveKey(key);
    const directory = resolve(target, "..");
    const temporary = `${target}.${randomUUID()}.partial`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.byteLength;
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        toNodeReadable(input.body),
        meter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await unlinkIfPresent(temporary);
      throw error;
    }

    return { key, sizeBytes, checksumSha256: hash.digest("hex") };
  }

  async open(key: string): Promise<ReadableStream<Uint8Array>> {
    const path = this.resolveKey(key);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new MediaObjectNotFoundError();
    } catch (error) {
      if (isMissingFileError(error)) throw new MediaObjectNotFoundError();
      throw error;
    }
    return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    await unlinkIfPresent(this.resolveKey(key));
  }

  async exists(key: string): Promise<boolean> {
    const path = this.resolveKey(key);
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  private resolveKey(key: string): string {
    if (!OBJECT_KEY_PATTERN.test(key)) throw new InvalidMediaObjectKeyError();
    const path = resolve(this.rootDirectory, ...key.split("/"));
    if (!path.startsWith(`${this.rootDirectory}/`)) {
      throw new InvalidMediaObjectKeyError();
    }
    return path;
  }
}

function createObjectKey(now = new Date()): string {
  const year = now.getUTCFullYear().toString().padStart(4, "0");
  const month = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  return join(year, month, randomUUID()).replaceAll("\\", "/");
}

function toNodeReadable(body: MediaBody): Readable {
  return body instanceof Uint8Array
    ? Readable.from([body])
    : Readable.fromWeb(body as NodeReadableStream);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
