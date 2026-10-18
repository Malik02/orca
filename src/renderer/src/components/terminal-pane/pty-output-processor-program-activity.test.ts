import { describe, expect, it, vi } from 'vitest'
import { createPtyOutputProcessor } from './pty-output-processor'
import {
  createPtyOutputSideEffectQueue,
  MAX_PENDING_PTY_SIDE_EFFECTS,
  type PendingPtySideEffect
} from './pty-output-side-effect-queue'

const osc7501 = (body: string): string => `\x1b]7501;${body}\x1b\\`

describe('renderer-owned PTY output with OSC 7501 activity', () => {
  it("fires agent edges from the program's reports while its titles carry no glyph", () => {
    const events: string[] = []
    const processor = createPtyOutputProcessor({
      onTitleChange: () => {},
      onAgentBecameIdle: (title) => events.push(`idle:${title}`),
      onAgentBecameWorking: () => events.push('working')
    })
    const callbacks = { onData: () => {} }
    processor.processData(
      `${osc7501('state=idle:app=claude-code')}\x1b]0;Claude Code\x07`,
      callbacks
    )
    processor.processData(osc7501('state=working:app=claude-code'), callbacks)
    processor.processData('\x1b]0;Fix the parser\x07', callbacks)
    processor.processData(osc7501('state=done:app=claude-code'), callbacks)
    processor.flushPendingSideEffects()

    expect(events).toEqual(['working', 'idle:Fix the parser'])
  })
})

describe('PTY side-effect queue with program activity', () => {
  const effect = (overrides: Partial<PendingPtySideEffect> = {}): PendingPtySideEffect => ({
    payloads: [],
    titles: [],
    titleScanEffect: 'none',
    containsBell: false,
    suppressAttentionEvents: false,
    ...overrides
  })

  it('never coalesces an activity change away', () => {
    const applied: PendingPtySideEffect[] = []
    const queue = createPtyOutputSideEffectQueue({
      countWorkingTitles: () => 0,
      apply: (next) => applied.push(next)
    })
    queue.enqueue(effect())
    queue.enqueue(effect({ programActivity: ['working'] }))
    queue.enqueue(effect())
    queue.flush()
    expect(applied.flatMap((next) => next.programActivity ?? [])).toEqual(['working'])
  })

  it('carries the last evicted activity onto the surviving entry', () => {
    vi.useFakeTimers()
    const applied: PendingPtySideEffect[] = []
    const queue = createPtyOutputSideEffectQueue({
      countWorkingTitles: () => 0,
      apply: (next) => applied.push(next)
    })
    queue.enqueue(effect({ programActivity: ['working', 'idle'], titles: ['a'] }))
    for (let index = 0; index < MAX_PENDING_PTY_SIDE_EFFECTS; index += 1) {
      queue.enqueue(effect({ titles: [`t${index}`] }))
    }
    queue.flush()
    expect(applied[0].programActivity).toEqual(['idle'])
    vi.useRealTimers()
  })
})
