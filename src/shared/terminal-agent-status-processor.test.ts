import { describe, expect, it } from 'vitest'
import { createTerminalAgentStatusProcessor } from './terminal-agent-status-processor'

describe('createTerminalAgentStatusProcessor', () => {
  it('returns OSC 9999 chunks untouched when no OSC 7501 record changed', () => {
    const process = createTerminalAgentStatusProcessor()
    const result = process('a\x1b]9999;{"state":"working","prompt":"p"}\x07b')
    expect(result.cleanData).toBe('ab')
    expect(result.programStatusPayloads).toBeUndefined()
  })

  it('appends OSC 7501 projections, marks them, and leaves the sequence in the stream', () => {
    const process = createTerminalAgentStatusProcessor()
    const data = 'x\x1b]7501;state=working:app=codex\x1b\\y'
    const result = process(data)
    expect(result.cleanData).toBe(data)
    expect(result.payloads).toMatchObject([{ state: 'working', agentType: 'codex' }])
    expect(result.programStatusPayloads?.has(result.payloads[0])).toBe(true)
    expect(result.lastPayloadCleanOffset).toBe(data.length - 1)
  })

  it('merges OSC 9999 and OSC 7501 in one chunk, leaving titles untouched', () => {
    const process = createTerminalAgentStatusProcessor()
    const report = '\x1b]7501;state=working:app=claude-code\x1b\\'
    const result = process(
      `a\x1b]9999;{"state":"done","prompt":"p"}\x07${report}\x1b]0;Refactor\x07b`
    )
    expect(result.cleanData).toBe(`a${report}\x1b]0;Refactor\x07b`)
    expect(result.payloads).toMatchObject([{ state: 'done' }, { state: 'working' }])
    expect(result.programStatusPayloads?.has(result.payloads[1])).toBe(true)
    expect(result.programStatusPayloads?.has(result.payloads[0])).toBe(false)
    expect(result.lastPayloadCleanOffset).toBe(1 + report.length)
    expect(result.programStatusFacet).toMatchObject({ state: 'working' })
    expect(result.programActivity).toEqual(['working'])
  })

  it('reports each activity change once, and null when the program stops reporting', () => {
    const process = createTerminalAgentStatusProcessor()
    const osc = (body: string) => `\x1b]7501;${body}\x1b\\`
    expect(process(osc('state=idle:app=x') + osc('state=done:app=x')).programActivity).toEqual([
      'idle'
    ])
    expect(process(osc('state=blocked:kind=auth:app=x')).programActivity).toEqual(['permission'])
    expect(process(osc('state=clear')).programActivity).toEqual([null])
  })
})
