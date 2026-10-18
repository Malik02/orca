import { describe, expect, it } from 'vitest'
import { createProgramStatusProjector } from './agent-status-projector'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const osc = (body: string): string => `\x1b]7501;${body}\x1b\\`

function projector() {
  let clock = 1000
  const instance = createProgramStatusProjector(() => clock)
  return {
    feed: (data: string) => instance.process(data).payloads.map(({ payload }) => payload),
    tick: (ms: number) => {
      clock += ms
    }
  }
}

describe('createProgramStatusProjector', () => {
  it('maps a Claude Code turn onto Orca agent states', () => {
    const { feed, tick } = projector()
    expect(feed(osc('state=idle:app=claude-code'))).toEqual([
      {
        state: 'done',
        prompt: '',
        agentType: 'claude',
        sessionBoundary: true,
        mainAgent: { state: 'done', stateStartedAt: 1000 }
      }
    ])
    tick(5)
    expect(feed(osc(`state=working:app=claude-code:msg=${b64('Fixing the parser')}`))).toEqual([
      {
        state: 'working',
        prompt: '',
        agentType: 'claude',
        toolInput: 'Fixing the parser',
        mainAgent: { state: 'working', stateStartedAt: 1005 }
      }
    ])
    tick(5)
    expect(
      feed(
        osc(
          `state=blocked:kind=permission:app=claude-code:msg=${b64('approve Bash: rm -rf build')}`
        )
      )
    ).toMatchObject([{ state: 'waiting', toolInput: 'approve Bash: rm -rf build' }])
    tick(5)
    expect(feed(osc(`state=done:app=claude-code:msg=${b64('Parser fixed')}`))).toEqual([
      {
        state: 'done',
        prompt: '',
        agentType: 'claude',
        lastAssistantMessage: 'Parser fixed',
        mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1015 }
      }
    ])
  })

  it('reports auth and unnamed blocks as blocked, errors as failed turns', () => {
    const { feed } = projector()
    expect(feed(osc('state=blocked:kind=auth:app=pi'))).toMatchObject([
      { state: 'blocked', agentType: 'pi' }
    ])
    expect(feed(osc(`state=error:app=pi:msg=${b64('rate limited')}`))).toMatchObject([
      { state: 'done', lastAssistantMessage: 'rate limited', mainAgent: { outcome: 'failure' } }
    ])
  })

  it('reads idle as at rest, never as a cancelled turn, and keeps an unseen done', () => {
    const { feed } = projector()
    // Codex boots with a short working blip before settling idle.
    feed(osc('state=idle:app=codex'))
    feed(osc('state=working:app=codex'))
    const [settled] = feed(osc('state=idle:app=codex'))
    expect(settled).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(settled.interrupted).toBeUndefined()
    expect(settled.mainAgent?.outcome).toBeUndefined()
    feed(osc('state=working:app=codex'))
    feed(osc('state=done:app=codex'))
    expect(feed(osc('state=idle:app=codex'))).toEqual([])
  })

  it('emits only changes, so redraws that resend a report are silent', () => {
    const { feed } = projector()
    expect(feed(osc('state=working:app=omp'))).toHaveLength(1)
    expect(feed(osc('state=working:app=omp') + osc('state=working:app=omp'))).toEqual([])
  })

  it('ends a live program at the next shell prompt but keeps a finished one', () => {
    const { feed } = projector()
    feed(osc('state=working:app=pi'))
    expect(feed('\x1b]133;A\x07')).toMatchObject([{ state: 'done', sessionBoundary: true }])
    feed(osc('state=done:app=pi'))
    expect(feed('\x1b]133;A\x07')).toEqual([])
  })

  it('turns child records into subagent rows with inherited app and sanitized titles', () => {
    const { feed, tick } = projector()
    feed(osc('state=working:app=claude-code'))
    tick(10)
    expect(feed(osc(`state=working:id=task_1:title=${b64('‮Explore the repo')}`))).toMatchObject([
      {
        state: 'working',
        subagents: [
          {
            id: 'task_1',
            state: 'working',
            agentType: 'claude',
            description: 'Explore the repo',
            startedAt: 1010
          }
        ]
      }
    ])
    expect(feed(osc('state=blocked:kind=question:id=task_1'))).toMatchObject([
      { subagents: [{ id: 'task_1', state: 'waiting', startedAt: 1010 }] }
    ])
    const [cleared] = feed(osc('state=clear:id=task_1'))
    expect(cleared.subagents).toBeUndefined()
  })

  it('reads a clear during live work as the program leaving, not a cancelled turn', () => {
    const { feed } = projector()
    feed(osc('state=working:app=claude-code'))
    const [left] = feed(osc('state=clear'))
    expect(left).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(left.interrupted).toBeUndefined()
    expect(feed(osc('state=clear'))).toEqual([])
  })

  it("maps harness app ids onto Orca's agent ids so hook precedence can match them", () => {
    const { feed } = projector()
    expect(feed(osc('state=working:app=grok-build'))).toMatchObject([{ agentType: 'grok' }])
    expect(feed(osc('state=done:app=terraform'))).toMatchObject([{ agentType: 'terraform' }])
  })

  it('emits the net facet per chunk, including progress the lifecycle payload ignores', () => {
    let clock = 1
    const { process } = createProgramStatusProjector(() => clock)
    expect(process(osc('state=working:app=claude-code:progress=40')).facet).toEqual({
      state: 'working',
      progress: 40,
      observedAt: 1
    })
    clock = 2
    const tick = process(osc('state=working:app=claude-code:progress=55'))
    expect(tick.payloads).toEqual([])
    expect(tick.facet).toMatchObject({ progress: 55, observedAt: 2 })
    expect(process(osc('state=working:app=claude-code:progress=55')).facet).toBeUndefined()
    expect(process(osc('state=clear')).facet).toBeNull()
  })

  it('stays silent on children alone, then lists them once the root reports', () => {
    const { feed } = projector()
    expect(feed(osc('state=working:id=job'))).toEqual([])
    expect(feed(osc('state=working:app=pi'))).toMatchObject([
      { state: 'working', subagents: [{ id: 'job', state: 'working', agentType: 'pi' }] }
    ])
  })

  it("keeps a failed turn's verdict when the program settles idle", () => {
    const { feed } = projector()
    feed(osc('state=working:app=pi'))
    expect(feed(osc('state=error:app=pi'))).toMatchObject([{ mainAgent: { outcome: 'failure' } }])
    expect(feed(osc('state=idle:app=pi'))).toEqual([])
  })

  it("reports a child's app change as news", () => {
    const { feed } = projector()
    feed(osc('state=working:app=pi') + osc('state=working:id=job'))
    expect(feed(osc('state=working:id=job:app=codex'))).toMatchObject([
      { subagents: [{ id: 'job', agentType: 'codex' }] }
    ])
  })

  it('names a child by the tail of a long id', () => {
    const { feed } = projector()
    const id = ['a', 'b', 'c'].map((letter) => letter.repeat(30)).join('/')
    feed(osc('state=working:app=pi'))
    expect(feed(osc(`state=working:id=${id}`))).toMatchObject([
      { subagents: [{ id: id.slice(-64) }] }
    ])
  })
})
