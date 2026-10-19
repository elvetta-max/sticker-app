import bcrypt from "bcrypt";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { env } from "../../config/env.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
} from "../../lib/tokens.js";

const FAIL_PREFIX = "login:fail:";
const REFRESH_PREFIX = "auth:refresh:";
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_TTL_SECONDS = 15 * 60;

// A real bcrypt hash compared against when the username is unknown, so response
// timing does not reveal whether an account exists (user-enumeration defense).
let dummyHashPromise = null;
function getDummyHash() {
  dummyHashPromise ??= bcrypt.hash("invalid-password-placeholder", env.BCRYPT_ROUNDS);
  return dummyHashPromise;
}

/** @param {string} username */
function failKey(username) {
  return `${FAIL_PREFIX}${username.toLowerCase()}`;
}

/**
 * Issue an access token + a rotating opaque refresh token (stored hashed in Redis).
 * @param {{ prisma: any, redis: any, admin: { id: string, username: string } }} args
 */
async function issueTokens({ redis, admin }) {
  const accessToken = signAccessToken(admin);
  const { token, hash } = createRefreshToken();
  await redis.set(`${REFRESH_PREFIX}${hash}`, admin.id, "EX", REFRESH_TOKEN_TTL_SECONDS);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: token,
    admin: { id: admin.id, username: admin.username },
  };
}

/**
 * Authenticate an admin. Enforces account lockout after repeated failures.
 * @param {{ prisma: any, redis: any, username: string, password: string }} args
 */
export async function login({ prisma, redis, username, password }) {
  const key = failKey(username);
  const failed = Number(await redis.get(key)) || 0;

  const admin = await prisma.admin.findUnique({ where: { username } });
  const hash = admin?.password ?? (await getDummyHash());
  const passwordOk = await bcrypt.compare(password, hash);

  if (failed >= MAX_FAILED_ATTEMPTS) {
    throw new AppError(
      ErrorCodes.ACCOUNT_LOCKED,
      "Too many failed attempts. Please try again later.",
      429,
    );
  }

  if (!admin || !passwordOk) {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, LOCK_TTL_SECONDS);
    }
    throw new AppError(ErrorCodes.INVALID_CREDENTIALS, "Invalid username or password.", 401);
  }

  await redis.del(key);
  return issueTokens({ redis, admin });
}

/**
 * Exchange a valid refresh token for a fresh access token (rotating the refresh token).
 * @param {{ prisma: any, redis: any, token?: string }} args
 */
export async function refresh({ prisma, redis, token }) {
  if (!token) {
    throw AppError.unauthorized("Missing refresh token.");
  }

  const key = `${REFRESH_PREFIX}${hashRefreshToken(token)}`;
  const adminId = await redis.get(key);
  if (!adminId) {
    throw AppError.unauthorized("Invalid or expired refresh token.");
  }

  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) {
    await redis.del(key);
    throw AppError.unauthorized("Invalid refresh token.");
  }

  await redis.del(key);
  return issueTokens({ redis, admin });
}

/**
 * Revoke a refresh token (best-effort; safe to call with no token).
 * @param {{ redis: any, token?: string }} args
 */
export async function logout({ redis, token }) {
  if (token) {
    await redis.del(`${REFRESH_PREFIX}${hashRefreshToken(token)}`);
  }
}
