import {
  randomBytes,
  scrypt as nodeScrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const KEY_LENGTH = 64;
// OWASP 推荐在无法使用 Argon2id 时至少采用 scrypt N=2^17,r=8,p=1。
const COST = 131_072;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 192 * 1024 * 1024;
const PREFIX = "$scrypt$v=1$ln=17,r=8,p=1";

const dummySalt = Buffer.alloc(16);
const dummyHash = scryptSync("meet-invalid-password", dummySalt, KEY_LENGTH, {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: MAX_MEMORY,
});

export const DUMMY_PASSWORD_HASH = encodeHash(dummySalt, dummyHash);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await deriveKey(password, salt, KEY_LENGTH);

  return encodeHash(salt, derivedKey);
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parsed = parseHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const derivedKey = await deriveKey(password, parsed.salt, parsed.hash.length);

  return timingSafeEqual(derivedKey, parsed.hash);
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      keyLength,
      {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELIZATION,
        maxmem: MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function encodeHash(salt: Buffer, hash: Buffer): string {
  return `${PREFIX}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function parseHash(encodedHash: string): { salt: Buffer; hash: Buffer } | null {
  const [empty, algorithm, version, parameters, saltValue, hashValue, ...rest] =
    encodedHash.split("$");
  if (
    empty !== "" ||
    algorithm !== "scrypt" ||
    version !== "v=1" ||
    parameters !== "ln=17,r=8,p=1" ||
    !saltValue ||
    !hashValue ||
    rest.length > 0
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(saltValue, "base64url");
    const hash = Buffer.from(hashValue, "base64url");
    if (salt.length !== 16 || hash.length !== KEY_LENGTH) {
      return null;
    }
    return { salt, hash };
  } catch {
    return null;
  }
}
