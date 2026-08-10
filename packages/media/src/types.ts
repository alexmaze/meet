export type MediaBody = Uint8Array | ReadableStream<Uint8Array>;

export type MediaPutInput = {
  body: MediaBody;
  contentType: string;
};

export type MediaObject = {
  key: string;
  sizeBytes: number;
  checksumSha256: string;
};

export interface MediaStore {
  put(input: MediaPutInput): Promise<MediaObject>;
  open(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class MediaObjectNotFoundError extends Error {
  constructor() {
    super("Media object was not found.");
    this.name = "MediaObjectNotFoundError";
  }
}

export class InvalidMediaObjectKeyError extends Error {
  constructor() {
    super("Media object key is invalid.");
    this.name = "InvalidMediaObjectKeyError";
  }
}
