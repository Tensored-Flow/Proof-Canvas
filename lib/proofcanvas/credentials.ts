import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";

export const SCRYPT_COST = 32_768;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELIZATION = 1;
export const SCRYPT_KEY_BYTES = 32;
export const SCRYPT_SALT_BYTES = 16;
export const MIN_PASSWORD_BYTES = 16;
export const MAX_PASSWORD_BYTES = 1_024;

interface ParsedPasswordHash {
  salt: Buffer;
  digest: Buffer;
}

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, SCRYPT_KEY_BYTES, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

function base64UrlBytes(value: string, expectedBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Owner password hash contains invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedBytes || decoded.toString("base64url") !== value) {
    throw new Error("Owner password hash contains invalid encoded lengths");
  }
  return decoded;
}

export function parseOwnerPasswordHash(value: string): ParsedPasswordHash {
  const parts = value.split("$");
  if (
    parts.length !== 6
    || parts[0] !== "scrypt"
    || parts[1] !== String(SCRYPT_COST)
    || parts[2] !== String(SCRYPT_BLOCK_SIZE)
    || parts[3] !== String(SCRYPT_PARALLELIZATION)
  ) throw new Error(`PROOFCANVAS_OWNER_PASSWORD_HASH must use scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$<salt>$<digest>`);
  return {
    salt: base64UrlBytes(parts[4], SCRYPT_SALT_BYTES),
    digest: base64UrlBytes(parts[5], SCRYPT_KEY_BYTES),
  };
}

export async function hashOwnerPassword(password: string, salt = randomBytes(SCRYPT_SALT_BYTES)): Promise<string> {
  if (Buffer.byteLength(password, "utf8") < MIN_PASSWORD_BYTES || Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error(`Password must contain ${MIN_PASSWORD_BYTES}–${MAX_PASSWORD_BYTES} UTF-8 bytes`);
  }
  if (salt.length !== SCRYPT_SALT_BYTES) throw new Error(`Scrypt salt must contain ${SCRYPT_SALT_BYTES} bytes`);
  const digest = await scrypt(password, salt);
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyOwnerPassword(password: string, encodedHash: string): Promise<boolean> {
  const parsed = parseOwnerPasswordHash(encodedHash);
  const bounded = Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES ? password : password.slice(0, MAX_PASSWORD_BYTES);
  const candidate = await scrypt(bounded, parsed.salt);
  const matches = timingSafeEqual(candidate, parsed.digest);
  return matches && Buffer.byteLength(password, "utf8") >= MIN_PASSWORD_BYTES && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}
