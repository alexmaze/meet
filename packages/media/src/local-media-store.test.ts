import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidMediaObjectKeyError,
  LocalMediaStore,
  MediaObjectNotFoundError,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalMediaStore", () => {
  it("writes private objects and returns stable integrity metadata", async () => {
    const root = await temporaryDirectory();
    const store = new LocalMediaStore(root);
    const object = await store.put({
      body: new TextEncoder().encode("家庭媒体"),
      contentType: "text/plain",
    });

    expect(object.key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(object.sizeBytes).toBe(12);
    expect(object.checksumSha256).toHaveLength(64);
    expect(await store.exists(object.key)).toBe(true);
    expect(await readFile(join(root, ...object.key.split("/")), "utf8")).toBe(
      "家庭媒体",
    );
  });

  it("opens streams and deletes objects idempotently", async () => {
    const store = new LocalMediaStore(await temporaryDirectory());
    const object = await store.put({
      body: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    });
    const bytes = await collect(await store.open(object.key));
    expect(bytes).toEqual([1, 2, 3]);

    await store.delete(object.key);
    await store.delete(object.key);
    expect(await store.exists(object.key)).toBe(false);
    await expect(store.open(object.key)).rejects.toBeInstanceOf(
      MediaObjectNotFoundError,
    );
  });

  it("rejects object keys that could escape the configured root", async () => {
    const store = new LocalMediaStore(await temporaryDirectory());
    await expect(store.open("../../secret")).rejects.toBeInstanceOf(
      InvalidMediaObjectKeyError,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meet-media-"));
  directories.push(directory);
  return directory;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  const result: number[] = [];
  for await (const chunk of stream) result.push(...chunk);
  return result;
}
