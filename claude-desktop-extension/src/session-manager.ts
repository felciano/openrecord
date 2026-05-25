/**
 * Multi-account session manager for the OpenRecord MCPB.
 *
 * - One `MyChartRequest` per hostname, kept warm via keepalive pings.
 * - On first use: try the on-disk cookie cache, then a saved passkey, then
 *   the saved password (+ TOTP if configured).
 * - Auto-recovers from expiry by re-running login on the next call.
 * - Persists cookie state to disk after login so a Claude Desktop restart
 *   doesn't force a fresh login.
 *
 * Multiple accounts can be active simultaneously — every call carries an
 * explicit hostname, so there is no "active account" state to track.
 */

import { MyChartRequest } from '../../scrapers/myChart/myChartRequest';
import {
  myChartUserPassLogin,
  myChartPasskeyLogin,
  complete2faFlow,
  areCookiesValid,
} from '../../scrapers/myChart/login';
import { generateTotpCode } from '../../scrapers/myChart/totp';
import {
  deserializeCredential,
  serializeCredential,
} from '../../scrapers/myChart/softwareAuthenticator';
import {
  type AccountConfig,
  findAccount,
  readAccounts,
  readAccountPasskey,
  readAccountSession,
  saveAccountPasskey,
  saveAccountSession,
  clearAccountPasskey,
  clearAccountSession,
  normalizeHostname,
} from './credential-store';

interface SessionEntry {
  session: MyChartRequest;
  expired: boolean;
  keepAliveCounter: number;
  keepAliveErrorCount: number;
  keepAliveInterval: ReturnType<typeof setInterval> | null;
}

const sessions = new Map<string, SessionEntry>();
const loginLocks = new Map<string, Promise<MyChartRequest>>();

const KEEPALIVE_INTERVAL_MS = 30_000;
const KEEPALIVE_MAX_ERRORS = 3;

// ── Inspection ──────────────────────────────────────────────────────────────

export function isConnected(hostname: string): boolean {
  const entry = sessions.get(normalizeHostname(hostname));
  return !!entry && !entry.expired;
}

export function clearSession(hostname: string): void {
  const key = normalizeHostname(hostname);
  const entry = sessions.get(key);
  if (entry?.keepAliveInterval) clearInterval(entry.keepAliveInterval);
  sessions.delete(key);
  loginLocks.delete(key);
}

export function clearAllSessions(): void {
  for (const [, entry] of sessions) {
    if (entry.keepAliveInterval) clearInterval(entry.keepAliveInterval);
  }
  sessions.clear();
  loginLocks.clear();
}

// ── Login (cookie cache → passkey → user/pass + optional TOTP) ──────────────

/**
 * Try to restore a session from the on-disk cookie cache. Returns null if
 * no cache exists or the cached cookies have expired.
 */
async function tryRestoreSession(hostname: string): Promise<MyChartRequest | null> {
  const cached = readAccountSession(hostname);
  if (!cached) return null;
  try {
    const req = await MyChartRequest.unserialize(cached);
    if (!req) return null;
    if (await areCookiesValid(req)) return req;
  } catch {
    // fall through
  }
  clearAccountSession(hostname);
  return null;
}

async function loginAccount(account: AccountConfig): Promise<MyChartRequest> {
  const hostname = normalizeHostname(account.hostname);

  const restored = await tryRestoreSession(hostname);
  if (restored) return restored;

  const passkeySerialized = readAccountPasskey(hostname);
  if (passkeySerialized) {
    try {
      const credential = deserializeCredential(passkeySerialized);
      const result = await myChartPasskeyLogin({ hostname, credential });
      if (result.state === 'logged_in') {
        saveAccountPasskey(hostname, serializeCredential(credential));
        await persistSession(hostname, result.mychartRequest);
        return result.mychartRequest;
      }
      console.error(`[openrecord:${hostname}] passkey login failed (${result.state}), falling back to user/pass`);
      // Only clear if the passkey is actually invalid
      if (result.state === 'invalid_login') {
        clearAccountPasskey(hostname);
      }
    } catch (err) {
      console.error(`[openrecord:${hostname}] passkey login error: ${(err as Error).message}, falling back to user/pass`);
      // Do NOT clear passkey on generic errors (network, timeout, etc)
    }
  }

  const userPass = await myChartUserPassLogin({
    hostname,
    user: account.username,
    pass: account.password,
    skipSendCode: !!account.totpSecret,
  });

  if (userPass.state === 'logged_in') {
    await persistSession(hostname, userPass.mychartRequest);
    return userPass.mychartRequest;
  }

  if (userPass.state === 'invalid_login') {
    throw new Error(`Login failed for ${hostname}: username or password is incorrect. Run setup_account to update credentials.`);
  }

  if (userPass.state === 'need_2fa') {
    if (account.totpSecret) {
      const code = await generateTotpCode(account.totpSecret);
      const twoFa = await complete2faFlow({
        mychartRequest: userPass.mychartRequest,
        code,
        isTOTP: true,
      });
      if (twoFa.state === 'logged_in') {
        await persistSession(hostname, twoFa.mychartRequest);
        return twoFa.mychartRequest;
      }
      throw new Error(`TOTP rejected for ${hostname} (${twoFa.state}). Run setup_account to refresh.`);
    }
    throw new Error(`MyChart requires 2FA for ${hostname} and no passkey or TOTP is saved. Run setup_account to register one.`);
  }

  throw new Error(`Login failed for ${hostname}: ${userPass.state}${userPass.error ? ` — ${userPass.error}` : ''}`);
}

export async function persistSession(hostname: string, req: MyChartRequest): Promise<void> {
  try {
    saveAccountSession(hostname, await req.serialize());
  } catch (err) {
    console.error(`[openrecord:${hostname}] failed to persist session: ${(err as Error).message}`);
  }
}

// ── Session lifecycle (keepalive + lazy login) ──────────────────────────────

async function ensureAccountSession(account: AccountConfig): Promise<MyChartRequest> {
  const key = normalizeHostname(account.hostname);
  const entry = sessions.get(key);

  if (entry && !entry.expired) return entry.session;
  if (entry) clearSession(key);

  const lock = loginLocks.get(key);
  if (lock) return lock;

  const promise = loginAccount(account).then(session => {
    const newEntry: SessionEntry = {
      session,
      expired: false,
      keepAliveCounter: 0,
      keepAliveErrorCount: 0,
      keepAliveInterval: null,
    };

    newEntry.keepAliveInterval = setInterval(async () => {
      if (newEntry.expired) return;
      newEntry.keepAliveCounter++;
      try {
        const [a, b] = await Promise.all([
          session.makeRequest({ path: `/Home/KeepAlive?cnt=${newEntry.keepAliveCounter}`, followRedirects: false }),
          session.makeRequest({ path: `/keepalive.asp?cnt=${newEntry.keepAliveCounter}`, followRedirects: false }),
        ]);
        const aBody = await a.text();
        if (aBody.trim() === '0') {
          newEntry.expired = true;
          clearAccountSession(key);
        } else if (a.status !== 200 && b.status !== 200) {
          newEntry.expired = true;
          clearAccountSession(key);
        } else {
          newEntry.keepAliveErrorCount = 0;
        }
      } catch {
        newEntry.keepAliveErrorCount++;
        if (newEntry.keepAliveErrorCount >= KEEPALIVE_MAX_ERRORS) {
          newEntry.expired = true;
          newEntry.keepAliveErrorCount = 0;
          clearAccountSession(key);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);

    sessions.set(key, newEntry);
    loginLocks.delete(key);
    return session;
  }).catch(err => {
    loginLocks.delete(key);
    throw err;
  });

  loginLocks.set(key, promise);
  return promise;
}

/**
 * Get a logged-in MyChartRequest for the given hostname. Throws if no
 * account is configured for that hostname.
 */
export async function resolveSession(hostname: string): Promise<MyChartRequest> {
  if (!hostname) {
    throw new Error('account is required. Call list_accounts to see configured account IDs, then pass the hostname as `account`.');
  }
  const account = findAccount(hostname);
  if (!account) {
    const available = readAccounts().map(a => a.hostname);
    throw new Error(
      available.length === 0
        ? `No MyChart accounts configured. Call setup_account first.`
        : `Account "${hostname}" is not configured. Configured accounts: ${available.join(', ')}.`,
    );
  }
  return ensureAccountSession(account);
}

/**
 * Adopt an already-logged-in session (e.g. produced by setup_account or
 * complete_2fa) into the session manager so subsequent tool calls reuse
 * the cookies + benefit from keepalive.
 */
export async function adoptSession(hostname: string, session: MyChartRequest): Promise<void> {
  const key = normalizeHostname(hostname);
  clearSession(key);
  await persistSession(key, session);

  const newEntry: SessionEntry = {
    session,
    expired: false,
    keepAliveCounter: 0,
    keepAliveErrorCount: 0,
    keepAliveInterval: null,
  };
  newEntry.keepAliveInterval = setInterval(async () => {
    if (newEntry.expired) return;
    newEntry.keepAliveCounter++;
    try {
      const a = await session.makeRequest({ path: `/Home/KeepAlive?cnt=${newEntry.keepAliveCounter}`, followRedirects: false });
      const aBody = await a.text();
      if (aBody.trim() === '0' || a.status !== 200) {
        newEntry.expired = true;
        clearAccountSession(key);
      } else {
        newEntry.keepAliveErrorCount = 0;
      }
    } catch {
      newEntry.keepAliveErrorCount++;
      if (newEntry.keepAliveErrorCount >= KEEPALIVE_MAX_ERRORS) {
        newEntry.expired = true;
        newEntry.keepAliveErrorCount = 0;
        clearAccountSession(key);
      }
    }
  }, KEEPALIVE_INTERVAL_MS);
  sessions.set(key, newEntry);
}
