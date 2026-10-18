import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from './server/program-status/hook-precedence'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-program-status-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

function programStatus(payload: Omit<ParsedAgentStatusPayload, 'prompt'>): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', ...payload }
  })
}

async function openCodeHook(hookEventName: string): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: hookEventName, sessionID: 'ses_1' }),
    '/hook/opencode'
  )
  expect(response.status).toBe(204)
}

function paneRow() {
  return server.getStatusSnapshotForPane(PANE)[0]
}

describe('OSC 7501 status beside hooks', () => {
  it('drives the pane on its own when no hook reports it', () => {
    programStatus({ state: 'working', agentType: 'claude', toolInput: 'Fixing the parser' })
    expect(paneRow()).toMatchObject({
      state: 'working',
      agentType: 'claude',
      toolInput: 'Fixing the parser'
    })
    programStatus({ state: 'waiting', agentType: 'claude' })
    expect(paneRow()?.state).toBe('waiting')
  })

  it('yields to the same agent once its hooks own the row', async () => {
    await openCodeHook('SessionBusy')
    programStatus({ state: 'done', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('working')
    programStatus({ state: 'done' })
    expect(paneRow()?.state).toBe('working')
  })

  it('yields to a mid-turn hook row even under another app id', async () => {
    await openCodeHook('SessionBusy')
    programStatus({ state: 'done', agentType: 'claude' })
    expect(paneRow()).toMatchObject({ state: 'working', agentType: 'opencode' })
  })

  it('takes over when a different program reports after the hook agent finished', async () => {
    await openCodeHook('SessionIdle')
    programStatus({ state: 'working', agentType: 'terraform' })
    expect(paneRow()).toMatchObject({ state: 'working', agentType: 'terraform' })
  })

  it('never blocks a later hook event', async () => {
    programStatus({ state: 'working', agentType: 'opencode' })
    await openCodeHook('SessionIdle')
    expect(paneRow()?.state).toBe('done')
  })

  it('falls back to OSC 7501 once hooks go silent on a state the program has left', async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS)
    programStatus({ state: 'working', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('working')
    programStatus({ state: 'done', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('done')
    vi.useRealTimers()
    // The next hook event hands the pane back.
    await openCodeHook('SessionBusy')
    expect(paneRow()?.state).toBe('working')
  })

  describe('hybrid: the program facet rides whichever producer owns the row', () => {
    const facet = {
      state: 'working' as const,
      progress: 42,
      message: 'Running tests',
      observedAt: 1
    }

    it('stitches the facet onto a hook-owned row without touching its state', async () => {
      await openCodeHook('SessionBusy')
      const published: { state?: string; programStatus?: unknown; programStatusOnly?: true }[] = []
      server.setListener((row) =>
        published.push({
          state: row.payload.state,
          programStatus: row.programStatus,
          programStatusOnly: row.programStatusOnly
        })
      )
      published.length = 0
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      expect(published).toEqual([
        { state: 'working', programStatus: facet, programStatusOnly: true }
      ])
      expect(paneRow()).toMatchObject({
        state: 'working',
        agentType: 'opencode',
        programStatus: facet
      })

      // Redelivering the same content is not news.
      server.ingestProgramStatusFacet({ paneKey: PANE, facet: { ...facet, observedAt: 2 } })
      expect(published).toHaveLength(1)
    })

    it('tells row-mutation readers the row is unchanged, and skips identity-only rows', async () => {
      const mutations: Parameters<
        Parameters<AgentHookServer['subscribeStatusRowMutations']>[0]
      >[0][] = []
      server.subscribeStatusRowMutations((mutation) => mutations.push(mutation))
      const published: unknown[] = []
      server.setListener((row) => published.push(row))
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'resumed-session' },
        launchedAt: Date.now()
      })
      mutations.length = 0
      published.length = 0
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      expect(published).toEqual([])
      expect(mutations).toEqual([])

      await openCodeHook('SessionBusy')
      mutations.length = 0
      server.ingestProgramStatusFacet({ paneKey: PANE, facet: { ...facet, progress: 43 } })
      expect(mutations).toHaveLength(1)
      expect(mutations[0]?.before).toMatchObject({ paneKey: PANE })
      expect(mutations[0]?.after).toEqual(mutations[0]?.before)
    })

    it('keeps the facet across later hook events and drops it when the program clears', async () => {
      await openCodeHook('SessionBusy')
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      await openCodeHook('SessionIdle')
      expect(paneRow()).toMatchObject({ state: 'done', programStatus: facet })
      server.ingestProgramStatusFacet({ paneKey: PANE, facet: null })
      expect(paneRow()?.programStatus).toBeUndefined()
    })
  })
})
