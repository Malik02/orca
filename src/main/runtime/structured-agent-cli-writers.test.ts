import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import {
  assertCliConversationWritersExited,
  posixCliWriterShellAlone,
  type CliWriterHost
} from './structured-agent-cli-writers'
import { AgentStatusObservedPaneIdentities } from './agent-status-observed-pane-identity'

const snapshot = vi.hoisted(() => vi.fn())
vi.mock('../../shared/process-table-snapshot-reader', () => ({
  getFreshShellForegroundSnapshot: snapshot
}))

const row: AgentStatusIpcPayload = {
  paneKey: 'source',
  worktreeId: 'workspace',
  connectionId: null,
  agentType: 'codex',
  receivedAt: 1,
  stateStartedAt: 1,
  state: 'done',
  prompt: '',
  providerSession: { key: 'session_id', id: 'conversation' }
}
function inspection(verdict: AgentProcessVerdict | null = null) {
  let current = true
  let identity = 'original-pty'
  const observation: CliWriterObservation = {
    current: () => current,
    topology: 'pane-owned',
    presence: vi.fn(async () => verdict)
  }
  const host: CliWriterHost = {
    rows: () => [row],
    saved: () => [],
    observation: () => observation,
    pane: () => ({ ptyId: 'pty', incarnationId: identity, identity }),
    sleeping: () => false,
    terminal: () => ({
      execution: 'term:pty',
      pane: { ptyId: 'pty', incarnationId: identity, identity }
    }),
    links: () => [],
    shellAlone: vi.fn(async () => true)
  }
  return {
    host,
    observation,
    replaceRow: () => {
      current = false
    },
    replacePty: () => {
      identity = 'replacement-pty'
    },
    run: () => assertCliConversationWritersExited(host, 'codex', 'conversation')
  }
}
const refusal = {
  refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
}

beforeEach(() => vi.clearAllMocks())
describe('execution-host conversation writer inspection', () => {
  it('refuses live writers even with a foreground shell and retains suspended background children', async () => {
    const live = inspection('live')
    await expect(live.run()).rejects.toMatchObject(refusal)
    expect(live.host.shellAlone).not.toHaveBeenCalled()
    for (const stat of ['S', 'T']) {
      snapshot.mockResolvedValue([
        { pid: 10, ppid: 1, stat: 'Ss+', command: '/bin/zsh' },
        { pid: 11, ppid: 10, stat, command: 'custom-agent-alias' }
      ])
      expect(await posixCliWriterShellAlone(10)).toBe(false)
    }
    snapshot.mockResolvedValue([{ pid: 10, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }])
    expect(await posixCliWriterShellAlone(10)).toBe(true)
  })

  it('accepts exact exited or unchanged shell-only proof, never loss of evidence', async () => {
    await expect(inspection('unverifiable').run()).rejects.toMatchObject(refusal)
    await expect(inspection('exited').run()).resolves.toBeUndefined()
    await expect(inspection().run()).resolves.toBeUndefined()
    for (const cause of [
      'missing-pane',
      'missing-row',
      'sleeping',
      'failed-scan',
      'shared-server',
      'unknown-topology'
    ] as const) {
      const check = inspection()
      if (cause === 'missing-pane') {
        check.host.pane = () => null
      }
      if (cause === 'missing-row') {
        check.host.observation = () => null
      }
      if (cause === 'sleeping') {
        check.host.sleeping = () => true
      }
      if (cause === 'failed-scan') {
        check.host.rows = () => {
          throw new Error('unavailable')
        }
      }
      if (cause === 'shared-server') {
        check.observation.topology = 'shared'
      }
      if (cause === 'unknown-topology') {
        check.observation.topology = 'unverifiable'
      }
      await expect(check.run()).rejects.toMatchObject(refusal)
    }
  })

  it('refuses replaced conversation observations or terminal incarnations across awaits', async () => {
    for (const replace of ['row', 'pty'] as const) {
      const check = inspection('exited')
      check.observation.presence = async () => {
        if (replace === 'row') {
          check.replaceRow()
        } else {
          check.replacePty()
        }
        return 'exited'
      }
      await expect(check.run()).rejects.toMatchObject(refusal)
    }
  })

  it('requires current owned shell proof for saved resumes, including done checkpoints', async () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'source',
      worktreeId: 'workspace',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'conversation' },
      prompt: '',
      state: 'done',
      origin: 'live',
      capturedAt: 1,
      updatedAt: 1
    }
    const check = inspection('exited')
    let saved = [record]
    check.host.saved = () => saved
    check.host.rows = () => []
    check.host.sleeping = () => true
    await expect(check.run()).rejects.toMatchObject(refusal)
    check.host.sleeping = () => false
    const pane = check.host.pane
    check.host.pane = () => null
    await expect(check.run()).rejects.toMatchObject(refusal)
    check.host.pane = pane
    await expect(check.run()).resolves.toBeUndefined()
    await expect(
      assertCliConversationWritersExited(
        { ...check.host, saved: () => [{ ...record, agent: 'opencode2' }] },
        'opencode',
        'conversation'
      )
    ).rejects.toMatchObject(refusal)
    saved = [{ ...record, connectionId: 'ssh-A' }]
    await expect(check.run()).resolves.toBeUndefined()
    saved = [record]
    check.host.rows = () => [{ ...row, providerSession: { key: 'session_id', id: 'other' } }]
    await expect(check.run()).rejects.toMatchObject(refusal)
    check.host.rows = () => [row]
    await expect(check.run()).resolves.toBeUndefined()
    expect(check.host.shellAlone).toHaveBeenCalledTimes(2)
    check.host.shellAlone = async () => {
      saved = []
      return true
    }
    await expect(check.run()).rejects.toMatchObject(refusal)
    saved = [record]
    check.host.shellAlone = async () => {
      check.replacePty()
      return true
    }
    await expect(check.run()).rejects.toMatchObject(refusal)
    const newlySaved = inspection()
    newlySaved.host.saved = () => saved
    saved = []
    newlySaved.host.shellAlone = async () => {
      saved = [record]
      return true
    }
    await expect(newlySaved.run()).rejects.toMatchObject(refusal)
    const noRows = inspection()
    noRows.host.saved = () => saved
    noRows.host.rows = () => []
    noRows.host.shellAlone = async () => {
      noRows.host.rows = () => [
        { ...row, connectionId: 'ssh-A', providerSession: undefined, structuredHost: 'owned' }
      ]
      return true
    }
    await expect(noRows.run()).rejects.toMatchObject(refusal)
    noRows.host.rows = () => []
    noRows.host.shellAlone = async () => {
      record.providerSession.transcriptPath = 'changed'
      return true
    }
    await expect(noRows.run()).rejects.toMatchObject(refusal)
    noRows.host.shellAlone = async () => {
      noRows.replacePty()
      return true
    }
    await expect(noRows.run()).rejects.toMatchObject(refusal)
  })

  it('inspects the terminal a conversation leaves, whatever its rows now say', async () => {
    const check = inspection('exited')
    const identities = new AgentStatusObservedPaneIdentities()
    const report = (id: string) =>
      identities.record(
        'source',
        { kind: 'observed', terminalHandle: 'term', processIncarnation: 'pty', dispatchId: null },
        {
          paneKey: 'source',
          connectionId: null,
          receivedAt: 1,
          stateStartedAt: 1,
          providerSession: { key: 'session_id', id },
          payload: { state: 'done', prompt: '', agentType: 'codex' }
        }
      )
    const shell = { pid: 10, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }
    const census = async (run: () => Promise<void>) => {
      snapshot.mockResolvedValue([shell, { pid: 11, ppid: 10, stat: 'T', command: 'claude' }])
      await expect(run()).rejects.toMatchObject(refusal)
      snapshot.mockResolvedValue([shell])
      await expect(run()).resolves.toBeUndefined()
    }
    check.host.shellAlone = () => posixCliWriterShellAlone(10)
    check.host.links = () => {
      const observed = identities.read('source')
      return observed.kind === 'observed'
        ? [...(observed.conversations?.values() ?? [])].map((conversation) => ({
            ...conversation,
            paneKey: 'source',
            worktreeId: 'workspace',
            execution: 'term:pty'
          }))
        : []
    }
    // A later run in the same terminal overwrote the row while the paused agent stayed behind.
    report('conversation')
    report('later-run')
    check.host.rows = () => []
    await census(check.run)
    // The pane a header switch leaves is inspected even when nothing recorded the conversation there.
    check.host.links = () => []
    const header = () =>
      assertCliConversationWritersExited(check.host, 'codex', 'conversation', {
        paneKey: 'source',
        worktreeId: 'workspace'
      })
    await census(header)
    check.host.terminal = () => null
    await expect(header()).rejects.toMatchObject(refusal)
    // A row reloaded after restart has no observed identity, and its exited pid is not the census.
    check.host.terminal = () => ({
      execution: 'term:pty',
      pane: { ptyId: 'pty', incarnationId: 'pty', identity: 'pty' }
    })
    check.host.rows = () => [row]
    check.host.pane = () => null
    await census(check.run)
  })
})
