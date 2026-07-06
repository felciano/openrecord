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
