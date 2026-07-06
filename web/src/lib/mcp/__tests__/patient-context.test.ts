import { describe, it, expect } from 'bun:test'
import { resolvePatientArg, runInPatientContext, runPinnedToSelf, listPatients, type ProxyDeps } from '../patient-context'
import type { ProxyTarget } from '../../../../../scrapers/myChart/proxyContext'
import type { MyChartRequest } from '../../mychart/myChartRequest'

const target = (over: Partial<ProxyTarget>): ProxyTarget => ({
  id: 'id-1',
  displayName: 'Someone',
  isSelf: false,
  isSelected: false,
  linkUrl: '/x/inside.asp',
  source: 'proxy-switch-json',
  ...over,
})

const SELF = target({ id: 'id-self', displayName: 'Ramon Felciano', isSelf: true, isSelected: true })
const WIFE = target({ id: 'id-wife', displayName: 'Emma Example' })
const MOM = target({ id: 'id-mom', displayName: 'Rita Felciano' })
const TARGETS = [SELF, WIFE, MOM]

describe('resolvePatientArg', () => {
  it('omitted patient resolves to the self target', () => {
    const r = resolvePatientArg(TARGETS, undefined)
    expect(r).toEqual({ target: SELF })
  })

  it('empty-string patient resolves to the self target', () => {
    const r = resolvePatientArg(TARGETS, '')
    expect(r).toEqual({ target: SELF })
  })

  it('resolves by exact id', () => {
    const r = resolvePatientArg(TARGETS, 'id-mom')
    expect(r).toEqual({ target: MOM })
  })

  it('resolves by display name case-insensitively with surrounding whitespace', () => {
    const r = resolvePatientArg(TARGETS, '  emma example ')
    expect(r).toEqual({ target: WIFE })
  })

  it('unknown patient errors with the valid names listed', () => {
    const r = resolvePatientArg(TARGETS, 'Bob Nobody')
    if (!('error' in r)) throw new Error('expected error')
    expect(r.error).toContain('unknown_patient')
    expect(r.error).toContain('Bob Nobody')
    expect(r.error).toContain('Emma Example')
    expect(r.error).toContain('Rita Felciano')
  })

  it('ambiguous display name errors and names the candidates', () => {
    const twin = target({ id: 'id-twin', displayName: 'Emma Example' })
    const r = resolvePatientArg([...TARGETS, twin], 'Emma Example')
    if (!('error' in r)) throw new Error('expected error')
    expect(r.error).toContain('ambiguous_patient')
    expect(r.error).toContain('id-wife')
    expect(r.error).toContain('id-twin')
  })

  it('never partial-matches (substring is unknown, not a guess)', () => {
    const r = resolvePatientArg(TARGETS, 'Emma')
    if (!('error' in r)) throw new Error('expected error')
    expect(r.error).toContain('unknown_patient')
  })

  it('omitted patient with no self target errors rather than guessing', () => {
    const r = resolvePatientArg([WIFE, MOM], undefined)
    if (!('error' in r)) throw new Error('expected error')
    expect(r.error).toContain('proxy_discovery_failed')
  })
})

// The wrapper only uses `req` as an identity key and passes it through to fn/deps.
const makeReq = (): MyChartRequest => ({}) as unknown as MyChartRequest

// Build fake deps over a mutable "portal" whose selected target changes on switch.
function makePortal(initialTargets: ProxyTarget[]) {
  const state = { targets: initialTargets.map(t => ({ ...t })), discoverCalls: 0, switchCalls: 0 }
  const deps: ProxyDeps = {
    discover: async () => {
      state.discoverCalls += 1
      return state.targets.map(t => ({ ...t }))
    },
    switchTo: async (_req, target) => {
      state.switchCalls += 1
      const match = state.targets.find(t =>
        (target.id && t.id === target.id) ||
        (target.displayName && t.displayName.toLowerCase() === target.displayName.toLowerCase()))
      if (!match) throw new Error(`no such target`)
      state.targets.forEach(t => { t.isSelected = t === match })
      return { target: { ...match }, verifiedProfileName: match.displayName, verifiedDob: null }
    },
  }
  return { state, deps }
}

describe('runInPatientContext', () => {
  it('no-proxy account: passes through bare data with no echo and no switch', async () => {
    const { state, deps } = makePortal([])
    const result = await runInPatientContext(makeReq(), undefined, async () => ({ meds: [1] }), deps)
    expect(result).toEqual({ meds: [1] })
    expect(state.switchCalls).toBe(0)
  })

  it('no-proxy account: caches the no-proxy determination (one discovery for two calls)', async () => {
    const { state, deps } = makePortal([])
    const req = makeReq()
    await runInPatientContext(req, undefined, async () => 1, deps)
    await runInPatientContext(req, undefined, async () => 2, deps)
    expect(state.discoverCalls).toBe(1)
  })

  it('no-proxy account: explicit patient arg errors instead of passing through', async () => {
    const { deps } = makePortal([])
    await expect(
      runInPatientContext(makeReq(), 'Rita Felciano', async () => 1, deps)
    ).rejects.toThrow(/proxy_discovery_failed/)
  })

  it('a new session object (relogin) re-discovers instead of trusting the old cache', async () => {
    const { state, deps } = makePortal([])
    await runInPatientContext(makeReq(), undefined, async () => 1, deps)
    await runInPatientContext(makeReq(), undefined, async () => 2, deps)
    expect(state.discoverCalls).toBe(2)
  })

  it('already-on-target: verifies via fresh discovery, no switch, echoes patient', async () => {
    const { state, deps } = makePortal(TARGETS) // SELF isSelected from Task 2 fixtures
    const result = await runInPatientContext(makeReq(), undefined, async () => 'data', deps)
    expect(state.switchCalls).toBe(0)
    expect(result).toEqual({
      patient: { id: 'id-self', displayName: 'Ramon Felciano', isSelf: true },
      data: 'data',
    })
  })

  it('switches when the requested patient is not selected, echoes the verified target', async () => {
    const { state, deps } = makePortal(TARGETS)
    const result = await runInPatientContext(makeReq(), 'Rita Felciano', async () => 'mom-data', deps)
    expect(state.switchCalls).toBe(1)
    expect(result).toEqual({
      patient: { id: 'id-mom', displayName: 'Rita Felciano', isSelf: false },
      data: 'mom-data',
    })
  })

  it('proxy account with proxies: every call re-verifies (fresh discovery per call)', async () => {
    const { state, deps } = makePortal(TARGETS)
    const req = makeReq()
    await runInPatientContext(req, undefined, async () => 1, deps)
    await runInPatientContext(req, undefined, async () => 2, deps)
    expect(state.discoverCalls).toBe(2)
  })

  it('unknown patient rejects without calling fn', async () => {
    const { deps } = makePortal(TARGETS)
    let ran = false
    await expect(
      runInPatientContext(makeReq(), 'Bob Nobody', async () => { ran = true }, deps)
    ).rejects.toThrow(/unknown_patient/)
    expect(ran).toBe(false)
  })

  it('switch confirmation failure maps to context_verify_mismatch and fn never runs', async () => {
    const { deps } = makePortal(TARGETS)
    const failing: ProxyDeps = {
      ...deps,
      switchTo: async () => { throw new Error('Proxy target switch could not be confirmed after redirect chain.') },
    }
    let ran = false
    await expect(
      runInPatientContext(makeReq(), 'Emma Example', async () => { ran = true }, failing)
    ).rejects.toThrow(/context_verify_mismatch/)
    expect(ran).toBe(false)
  })

  it('other switch failures map to switch_failed', async () => {
    const { deps } = makePortal(TARGETS)
    const failing: ProxyDeps = {
      ...deps,
      switchTo: async () => { throw new Error('network reset') },
    }
    await expect(
      runInPatientContext(makeReq(), 'Emma Example', async () => 1, failing)
    ).rejects.toThrow(/switch_failed/)
  })

  it('serializes concurrent calls for different patients (no interleaving)', async () => {
    const { deps } = makePortal(TARGETS)
    const events: string[] = []
    const slow = (label: string, ms: number) => async () => {
      events.push(`${label}:start`)
      await new Promise(r => setTimeout(r, ms))
      events.push(`${label}:end`)
      return label
    }
    const req = makeReq()
    const [a, b] = await Promise.all([
      runInPatientContext(req, 'Emma Example', slow('wife', 30), deps),
      runInPatientContext(req, 'Rita Felciano', slow('mom', 5), deps),
    ])
    expect(events).toEqual(['wife:start', 'wife:end', 'mom:start', 'mom:end'])
    expect((a as { data: string }).data).toBe('wife')
    expect((b as { patient: { displayName: string } }).patient.displayName).toBe('Rita Felciano')
  })

  it('a failed call does not poison the mutex for the next call', async () => {
    const { deps } = makePortal(TARGETS)
    const req = makeReq()
    await expect(runInPatientContext(req, 'Bob Nobody', async () => 1, deps)).rejects.toThrow()
    const ok = await runInPatientContext(req, 'Emma Example', async () => 'fine', deps)
    expect((ok as { data: string }).data).toBe('fine')
  })
})

describe('runPinnedToSelf', () => {
  it('switches back to self after a proxy read left the portal on mom', async () => {
    const { state, deps } = makePortal(TARGETS)
    const req = makeReq()
    await runInPatientContext(req, 'Rita Felciano', async () => 'mom-data', deps)
    const result = await runPinnedToSelf(req, async () => 'self-write', deps)
    expect(result).toBe('self-write')
    expect(state.targets.find(t => t.isSelected)!.isSelf).toBe(true)
    expect(state.switchCalls).toBe(2) // to mom, back to self
  })

  it('no-proxy account: passthrough', async () => {
    const { deps } = makePortal([])
    const result = await runPinnedToSelf(makeReq(), async () => 'w', deps)
    expect(result).toBe('w')
  })
})

describe('listPatients', () => {
  it('maps targets to {id, displayName, isSelf}', async () => {
    const { deps } = makePortal(TARGETS)
    const patients = await listPatients(makeReq(), deps)
    expect(patients).toEqual([
      { id: 'id-self', displayName: 'Ramon Felciano', isSelf: true },
      { id: 'id-wife', displayName: 'Emma Example', isSelf: false },
      { id: 'id-mom', displayName: 'Rita Felciano', isSelf: false },
    ])
  })

  it('returns [] for accounts without proxy access', async () => {
    const { deps } = makePortal([])
    expect(await listPatients(makeReq(), deps)).toEqual([])
  })
})
