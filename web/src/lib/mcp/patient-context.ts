import type { MyChartRequest } from '../mychart/myChartRequest';
import {
  discoverProxyTargets,
  switchProxyTarget,
  type ProxyTarget,
} from '../../../../scrapers/myChart/proxyContext';

/** Minimal patient identity echoed on every patient-scoped response. */
export type PatientRef = { id: string; displayName: string; isSelf: boolean };

/**
 * Resolve an MCP `patient` argument against discovered proxy targets.
 * Strict: exact id match, or exact (case-insensitive, trimmed) display-name
 * match. Never partial-matches, never guesses. Omitted/empty -> self.
 */
export function resolvePatientArg(
  targets: ProxyTarget[],
  patient: string | undefined
): { target: ProxyTarget } | { error: string } {
  const validNames = targets.map(t => `'${t.displayName}'`).join(', ');

  if (!patient || !patient.trim()) {
    const self = targets.find(t => t.isSelf);
    if (!self) {
      return {
        error:
          `proxy_discovery_failed: could not identify the account holder's own record ` +
          `among the discovered patients (${validNames}). Refusing to guess.`,
      };
    }
    return { target: self };
  }

  const wanted = patient.trim();

  const byId = targets.filter(t => t.id && t.id === wanted);
  if (byId.length === 1) return { target: byId[0] };

  const wantedName = wanted.toLowerCase();
  const byName = targets.filter(t => t.displayName.trim().toLowerCase() === wantedName);
  if (byName.length === 1) return { target: byName[0] };
  if (byName.length > 1) {
    const candidates = byName.map(t => `'${t.displayName}' (id ${t.id || 'unknown'})`).join(', ');
    return {
      error:
        `ambiguous_patient: '${wanted}' matches multiple patients: ${candidates}. ` +
        `Pass the patient id instead of the name.`,
    };
  }

  return {
    error:
      `unknown_patient: '${wanted}' does not match any patient on this account. ` +
      `Valid patients: ${validNames}. Use list_patients to see who is available.`,
  };
}

/** Result wrapper for patient-scoped reads: whose record the data came from. */
export type PatientScoped<T> = { patient: PatientRef; data: T };

/** Injectable for tests; production callers use the defaults. */
export type ProxyDeps = {
  discover: typeof discoverProxyTargets;
  switchTo: typeof switchProxyTarget;
};

const defaultDeps: ProxyDeps = {
  discover: discoverProxyTargets,
  switchTo: switchProxyTarget,
};

// Both caches key on the MyChartRequest object identity: a relogin creates a
// new MyChartRequest, so stale patient-context state can never survive a
// session refresh (spec: "re-login resets context to self").
const NO_PROXY_TTL_MS = 15 * 60 * 1000;
const noProxyCache = new WeakMap<MyChartRequest, { fetchedAt: number }>();
const mutexes = new WeakMap<MyChartRequest, Promise<unknown>>();

/** Serialize all patient-context work per session. */
function withMutex<T>(req: MyChartRequest, fn: () => Promise<T>): Promise<T> {
  const prev = mutexes.get(req) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  mutexes.set(req, run.catch(() => undefined));
  return run;
}

function toRef(target: ProxyTarget): PatientRef {
  return { id: target.id, displayName: target.displayName, isSelf: target.isSelf };
}

/**
 * Pin the session to `patient` (omitted -> self), verify, then run `fn`.
 * Returns the verified patient identity alongside the data, or verified=null
 * for accounts with no proxy access (passthrough).
 */
async function pinAndRun<T>(
  req: MyChartRequest,
  patient: string | undefined,
  fn: (req: MyChartRequest) => Promise<T>,
  deps: ProxyDeps
): Promise<{ verified: PatientRef | null; data: T }> {
  // Fast path: recently confirmed no-proxy account and no explicit patient.
  const noProxy = noProxyCache.get(req);
  if (!patient && noProxy && Date.now() - noProxy.fetchedAt < NO_PROXY_TTL_MS) {
    return { verified: null, data: await fn(req) };
  }

  return withMutex(req, async () => {
    // Fresh discovery on every call: doubles as the per-call verification
    // (isSelected reflects the portal's actual current context).
    const targets = await deps.discover(req);

    if (targets.length === 0) {
      noProxyCache.set(req, { fetchedAt: Date.now() });
      if (patient && patient.trim()) {
        throw new Error(
          `proxy_discovery_failed: this MyChart account has no proxy patients, ` +
          `so patient '${patient}' cannot be selected. Only the account holder's ` +
          `own record is available (omit the patient parameter).`
        );
      }
      return { verified: null, data: await fn(req) };
    }
    noProxyCache.delete(req);

    const resolved = resolvePatientArg(targets, patient);
    if ('error' in resolved) throw new Error(resolved.error);
    const desired = resolved.target;

    const current = targets.find(t => t.isSelected) || null;
    const alreadyActive = desired.isSelf
      ? !!current?.isSelf
      : !!current && current.id === desired.id;

    let verified: ProxyTarget;
    if (alreadyActive && current) {
      verified = current;
    } else {
      // Prefer id; the self target from some discovery fallbacks has id ''.
      const ref = desired.id ? { id: desired.id } : { displayName: desired.displayName };
      try {
        const switched = await deps.switchTo(req, ref, { discoveredTargets: targets });
        verified = switched.target;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const kind = msg.includes('could not be confirmed')
          ? 'context_verify_mismatch'
          : 'switch_failed';
        throw new Error(
          `${kind}: unable to set the patient context to '${desired.displayName}'. ` +
          `No data was fetched. (${msg})`
        );
      }
    }

    return { verified: toRef(verified), data: await fn(req) };
  });
}

/**
 * Patient-scoped read: pins to the requested patient (default self) and wraps
 * the result with a patient echo. Accounts without proxies get bare data.
 */
export async function runInPatientContext<T>(
  req: MyChartRequest,
  patient: string | undefined,
  fn: (req: MyChartRequest) => Promise<T>,
  deps: ProxyDeps = defaultDeps
): Promise<PatientScoped<T> | T> {
  const { verified, data } = await pinAndRun(req, patient, fn, deps);
  return verified ? { patient: verified, data } : data;
}

/**
 * Self-pinned operation (all write/action tools): forces the session back to
 * the account holder before running, so a preceding proxy read can never leak
 * its context into a write. Response shape is unchanged (no echo).
 */
export async function runPinnedToSelf<T>(
  req: MyChartRequest,
  fn: (req: MyChartRequest) => Promise<T>,
  deps: ProxyDeps = defaultDeps
): Promise<T> {
  const { data } = await pinAndRun(req, undefined, fn, deps);
  return data;
}

/** Discovered patients for the list_patients tool. [] = no proxy access. */
export async function listPatients(
  req: MyChartRequest,
  deps: ProxyDeps = defaultDeps
): Promise<PatientRef[]> {
  const targets = await deps.discover(req);
  return targets.map(toRef);
}
