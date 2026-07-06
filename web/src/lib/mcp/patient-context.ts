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

/**
 * Tracks whether this session has ever switched to a non-self proxy patient.
 * True  = the portal was previously on a proxy record; a subsequent empty
 *         discovery result is dangerously ambiguous and must not pass through.
 * False/absent = session has always been on self; an empty discovery result
 *         safely means "this account has no proxy access".
 */
const switchedToProxy = new WeakMap<MyChartRequest, boolean>();

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

type PinAndRunOpts = {
  /**
   * When true, a warm no-proxy cache (and no explicit patient arg) allows
   * the call to bypass discovery and run fn directly. Must be false for any
   * write/self-pinned operation so that discovery always verifies the context.
   */
  allowFastPath: boolean;
};

/**
 * Pin the session to `patient` (omitted -> self), verify, then run `fn`.
 * Returns the verified patient identity alongside the data, or verified=null
 * for accounts with no proxy access (passthrough).
 */
async function pinAndRun<T>(
  req: MyChartRequest,
  patient: string | undefined,
  fn: (req: MyChartRequest) => Promise<T>,
  deps: ProxyDeps,
  opts: PinAndRunOpts = { allowFastPath: true }
): Promise<{ verified: PatientRef | null; data: T }> {
  return withMutex(req, async () => {
    // [Fix 2] Fast path moved inside the mutex: prevents a concurrent switch from
    // interleaving with a fast-path read on the same req (TOCTOU). The serialization
    // cost is acceptable on a single-operator server.
    // Guarded by allowFastPath (writes must never skip discovery) and by
    // switchedToProxy (a session that previously switched to a proxy patient
    // must always re-verify — a warm no-proxy cache from before the switch
    // would be dangerously stale).
    const noProxy = noProxyCache.get(req);
    if (
      opts.allowFastPath &&
      !patient &&
      noProxy &&
      Date.now() - noProxy.fetchedAt < NO_PROXY_TTL_MS &&
      switchedToProxy.get(req) !== true
    ) {
      return { verified: null, data: await fn(req) };
    }

    // Fresh discovery on every call: doubles as the per-call verification
    // (isSelected reflects the portal's actual current context).
    const targets = await deps.discover(req);

    if (targets.length === 0) {
      // If this session previously switched toward a proxy patient the current
      // patient context is unknown — fail closed rather than letting a transient
      // discovery failure silently pass through as "no proxy access".
      if (switchedToProxy.get(req) === true) {
        throw new Error(
          `proxy_discovery_failed: proxy discovery returned no patients while verifying the context` +
          `${patient ? ` for '${patient}'` : ''}; the session previously switched toward a proxy ` +
          `record, so the active patient context cannot be verified. No data was fetched. Retry, or reconnect the instance.`
        );
      }
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
      // [Fix 1] Set switchedToProxy pessimistically BEFORE the switch attempt.
      // switchProxyTarget executes a redirect chain that may move the portal to the
      // new target BEFORE it can confirm. If it then throws, the portal may already
      // be on the requested target — leaving the flag unset would allow a subsequent
      // transient empty discovery to silently pass through as "no proxy".
      // In the else branch, alreadyActive was false, so even a self-switch means the
      // current context is not verified self — set flag true to fail closed on error.
      // The post-success block below updates it accurately once we have verified landing.
      switchedToProxy.set(req, true);
      noProxyCache.delete(req);
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

    // Update the switchedToProxy flag based on where the session landed.
    // This flag is the guard that prevents a stale no-proxy cache from
    // masquerading as "safe self context" after the portal was switched.
    if (verified.isSelf) {
      switchedToProxy.set(req, false);
    } else {
      switchedToProxy.set(req, true);
      noProxyCache.delete(req); // belt-and-suspenders: clear any stale no-proxy entry
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
 *
 * Never uses the no-proxy fast path — discovery is always performed so that
 * the patient context is freshly verified before every write.
 */
export async function runPinnedToSelf<T>(
  req: MyChartRequest,
  fn: (req: MyChartRequest) => Promise<T>,
  deps: ProxyDeps = defaultDeps
): Promise<T> {
  const { data } = await pinAndRun(req, undefined, fn, deps, { allowFastPath: false });
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
