import "server-only";

// Password hashing with Node's built-in scrypt — no dependency to install.
//
// scrypt is memory-hard, which is what makes offline guessing expensive. The
// parameters are OWASP's recommended minimum (N = 2^17, r = 8, p = 1), and they
// are STORED IN EACH HASH (`scrypt$N$r$p$salt$hash`), so the cost can be raised
// later without breaking a single existing account: verification always uses the
// parameters the hash was made with.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const ALGORITHM = "scrypt";
const COST = 2 ** 17; // N
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt needs about 128 * N * r bytes — 128 MiB at the parameters above — and
 * Node's default ceiling is 32 MiB, so the limit is raised explicitly. Twice the
 * requirement leaves headroom for a future cost bump stored in older hashes.
 */
const MAX_MEMORY = 256 * 1024 * 1024;

interface ScryptParams {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelism: number;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: params.cost, r: params.blockSize, p: params.parallelism, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Hash a new password. Every call gets a fresh random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const params: ScryptParams = { cost: COST, blockSize: BLOCK_SIZE, parallelism: PARALLELISM };
  const key = await derive(password, salt, params);
  return [
    ALGORITHM,
    params.cost,
    params.blockSize,
    params.parallelism,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * True when `password` matches `stored`. A malformed stored value is a mismatch,
 * never an exception, and the comparison is constant-time.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, salt, key] = stored.split("$");
  if (algorithm !== ALGORITHM || !cost || !blockSize || !parallelism || !salt || !key) {
    return false;
  }

  const params: ScryptParams = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism),
  };
  if (![params.cost, params.blockSize, params.parallelism].every(Number.isSafeInteger)) {
    return false;
  }

  const expected = Buffer.from(key, "base64");
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await derive(password, Buffer.from(salt, "base64"), params);
  return timingSafeEqual(actual, expected);
}
