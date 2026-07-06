import { describe, it, expect } from 'bun:test'
import { resolvePatientArg } from '../patient-context'
import type { ProxyTarget } from '../../../../../scrapers/myChart/proxyContext'

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
