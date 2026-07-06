import { describe, it, expect } from 'bun:test'
import {
  TOOL_DEFINITIONS,
  PATIENT_SCOPED_TOOLS,
  SELF_PINNED_TOOLS,
  META_TOOLS,
} from '../tool-definitions'

describe('tool scope partition', () => {
  it('every tool belongs to exactly one scope set', () => {
    for (const def of TOOL_DEFINITIONS) {
      const memberships = [
        PATIENT_SCOPED_TOOLS.has(def.name),
        SELF_PINNED_TOOLS.has(def.name),
        META_TOOLS.has(def.name),
      ].filter(Boolean).length
      expect(`${def.name}:${memberships}`).toBe(`${def.name}:1`)
    }
  })

  it('the scope sets contain no stale names', () => {
    const defined = new Set(TOOL_DEFINITIONS.map(d => d.name))
    for (const name of [...PATIENT_SCOPED_TOOLS, ...SELF_PINNED_TOOLS, ...META_TOOLS]) {
      expect(defined.has(name)).toBe(true)
    }
  })

  it('patient-scoped tools accept a patient parameter; others do not', () => {
    for (const def of TOOL_DEFINITIONS) {
      const hasPatient = !!def.inputSchema && 'patient' in def.inputSchema
      expect(`${def.name}:${hasPatient}`).toBe(`${def.name}:${PATIENT_SCOPED_TOOLS.has(def.name)}`)
    }
  })

  it('write/action tools are all self-pinned', () => {
    for (const name of ['send_message', 'send_reply', 'request_refill',
      'add_emergency_contact', 'update_emergency_contact', 'remove_emergency_contact',
      'book_appointment']) {
      expect(SELF_PINNED_TOOLS.has(name)).toBe(true)
    }
  })

  it('list_patients exists and is a meta tool', () => {
    expect(TOOL_DEFINITIONS.some(d => d.name === 'list_patients')).toBe(true)
    expect(META_TOOLS.has('list_patients')).toBe(true)
  })
})
