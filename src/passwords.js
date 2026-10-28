import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

const PREHASHED_BCRYPT_PREFIX = "sha256-bcrypt:";

function prehash(password) {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

export async function hashPassword(password) {
  const hash = await bcrypt.hash(prehash(password), 12);
  return `${PREHASHED_BCRYPT_PREFIX}${hash}`;
}

export async function verifyPassword(password, storedHash) {
  if (storedHash.startsWith(PREHASHED_BCRYPT_PREFIX)) {
    return bcrypt.compare(
      prehash(password),
      storedHash.slice(PREHASHED_BCRYPT_PREFIX.length),
    );
  }

  return bcrypt.compare(password, storedHash);
}
