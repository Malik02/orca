import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: {
    activeWorktreeId: string | null
    setActiveWorktree: ReturnType<typeof vi.fn>
    shutdownWorktreeBrowsers: ReturnType<typeof vi.fn>
    shutdownWorktreeTerminals: ReturnType<typeof vi.fn>
    suppressPtyExit: ReturnType<typeof vi.fn>
    consumeSuppressedPtyExit: ReturnType<typeof vi.fn>
    tabsByWorktree: Record<string, { id: string }[]>
    ptyIdsByTabId: Record<string, string[]>
    worktreesByRepo: Record<string, { id: string; repoId: string; hostId?: string }[]>
    detectedWorktreesByRepo: Record<string, never>
    unifiedTabsByWorktree: Record<string, Tab[]>
    markWorkspaceChatsSlept: ReturnType<typeof vi.fn>
    clearWorkspaceChatsSlept: ReturnType<typeof vi.fn>
  } = {
    activeWorktreeId: null,
    setActiveWorktree: vi.fn((worktreeId: string | null) => {
      state.activeWorktreeId = worktreeId
    }),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined),
    suppressPtyExit: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(),
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    unifiedTabsByWorktree: {},
    markWorkspaceChatsSlept: vi.fn(),
    clearWorkspaceChatsSlept: vi.fn()
  }
  const suspendWorkspace = vi.fn().mockResolvedValue(null)
  const toastError = vi.fn()
  const markWorktreeSleepIntent = vi.fn()
  const clearWorktreeSleepIntent = vi.fn()
  const callChat = vi.fn()
  const hasWorktreeSleepIntent = vi.fn(() => true)
  return {
    callChat,
    hasWorktreeSleepIntent,
    clearWorktreeSleepIntent,
    markWorktreeSleepIntent,
    state,
    suspendWorkspace,
    toastError
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/worktree-sleep-intent', () => ({
  clearWorktreeSleepIntent: mocks.clearWorktreeSleepIntent,
  markWorktreeSleepIntent: mocks.markWorktreeSleepIntent,
  hasWorktreeSleepIntent: mocks.hasWorktreeSleepIntent,
  withWorktreeSleepTeardown: (_worktreeId: string, teardown: () => Promise<unknown>) => teardown()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callChat
}))

import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { Tab } from '../../../../shared/tab-types'
import {
  runSleepWorktree,
  runSleepWorktrees,
  sleepWorktreesReportingFailures
} from './sleep-worktree-flow'

describe('runSleepWorktree', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', {
      api: {
        ephemeralVm: {
          suspendWorkspace: mocks.suspendWorkspace
        }
      },
      requestAnimationFrame: vi.fn()
    })
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockResolvedValue(undefined)
    mocks.state.suppressPtyExit.mockClear()
    mocks.state.consumeSuppressedPtyExit.mockClear()
    mocks.suspendWorkspace.mockClear().mockResolvedValue(null)
    mocks.markWorktreeSleepIntent.mockClear()
    mocks.clearWorktreeSleepIntent.mockClear()
    mocks.toastError.mockClear()
    mocks.state.activeWorktreeId = null
    mocks.state.tabsByWorktree = {}
    mocks.state.ptyIdsByTabId = {}
    mocks.state.worktreesByRepo = {}
    mocks.callChat.mockReset().mockResolvedValue({ stoppedSessionIds: [] })
    mocks.hasWorktreeSleepIntent.mockReset().mockReturnValue(true)
    mocks.state.unifiedTabsByWorktree = {}
    mocks.state.markWorkspaceChatsSlept.mockClear()
    mocks.state.clearWorkspaceChatsSlept.mockClear()
  })

  const chat = (id: string, worktreeId: string, executionHostId: Tab['executionHostId']): Tab => ({
    id,
    entityId: `session-${id}`,
    groupId: 'group-1',
    worktreeId,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    executionHostId,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  })

  it('tears down browsers before terminals on the sleep path', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    // Why: browsers must run first so destroyPersistentWebview can unregister
    // the Chromium guests while browserTabsByWorktree/browserPagesByWorkspace
    // are still populated. If terminals ran first and kept its old
    // browserTabsByWorktree delete, browsers would no-op and leak webviews.
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-1', {
      keepIdentifiers: true
    })
    expect(mocks.suspendWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-1' })
    const browsersCallOrder = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    const terminalsCallOrder = mocks.state.shutdownWorktreeTerminals.mock.invocationCallOrder[0]
    const suspendCallOrder = mocks.suspendWorkspace.mock.invocationCallOrder[0]
    expect(browsersCallOrder).toBeLessThan(terminalsCallOrder)
    expect(terminalsCallOrder).toBeLessThan(suspendCallOrder)
  })

  it('clears activeWorktreeId before teardown when the slept worktree is active', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    const browsersCall = mocks.state.shutdownWorktreeBrowsers.mock.invocationCallOrder[0]
    expect(activeClear).toBeLessThan(browsersCall)
  })

  it('marks sleep intent before clearing the active slept worktree and keeps it after teardown', async () => {
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    const markCall = mocks.markWorktreeSleepIntent.mock.invocationCallOrder[0]
    const activeClear = mocks.state.setActiveWorktree.mock.invocationCallOrder[0]
    expect(markCall).toBeLessThan(activeClear)
    // Why: the marker outlives a successful sleep so mounted panes stay cold until an explicit wake.
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('preserves active row position through section-scoped sidebar row ids', async () => {
    const requestAnimationFrame = vi.fn(() => 1)
    const scroller = {
      dispatchEvent: vi.fn(),
      scrollHeight: 100,
      scrollTop: 0
    }
    const row = {
      closest: (selector: string) => (selector === '[data-worktree-virtual-row]' ? row : null),
      getBoundingClientRect: () => ({ top: 42 })
    }
    const option = {
      dataset: { worktreeId: 'wt-1' },
      closest: (selector: string) => (selector === '[data-worktree-virtual-row]' ? row : null),
      querySelector: () => null
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-worktree-sidebar]' ? scroller : null,
      querySelectorAll: (selector: string) => (selector === '[data-worktree-id]' ? [option] : [])
    })
    vi.stubGlobal('window', { requestAnimationFrame })
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
  })

  it('anchors sleep restoration to the natural duplicate row when no primary row is marked', async () => {
    const requestAnimationFrame = vi.fn(() => 1)
    const scroller = {
      dispatchEvent: vi.fn(),
      scrollHeight: 100,
      scrollTop: 0
    }
    const pinnedGetBoundingClientRect = vi.fn(() => ({ top: 10 }))
    const naturalGetBoundingClientRect = vi.fn(() => ({ top: 42 }))
    const pinnedRow = {
      getBoundingClientRect: pinnedGetBoundingClientRect
    }
    const naturalRow = {
      getBoundingClientRect: naturalGetBoundingClientRect
    }
    const pinnedOption = {
      dataset: { worktreeId: 'wt-1', worktreeRowKey: 'pinned:wt-1' },
      closest: (selector: string) =>
        selector === '[data-worktree-virtual-row]' ? pinnedRow : null,
      querySelector: () => null
    }
    const naturalOption = {
      dataset: { worktreeId: 'wt-1', worktreeRowKey: 'all:wt-1' },
      closest: (selector: string) =>
        selector === '[data-worktree-virtual-row]' ? naturalRow : null,
      querySelector: () => null
    }
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector === '[data-worktree-sidebar]' ? scroller : null,
      querySelectorAll: (selector: string) =>
        selector === '[data-worktree-id]' ? [pinnedOption, naturalOption] : []
    })
    vi.stubGlobal('window', { requestAnimationFrame })
    mocks.state.activeWorktreeId = 'wt-1'

    await runSleepWorktree('wt-1')

    expect(naturalGetBoundingClientRect).toHaveBeenCalled()
    expect(pinnedGetBoundingClientRect).not.toHaveBeenCalled()
  })

  it('leaves activeWorktreeId alone and marks a background worktree slept', async () => {
    mocks.state.activeWorktreeId = 'wt-other'

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.state.suppressPtyExit).not.toHaveBeenCalled()
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
  })

  it('leaves a worktree the user activated mid-batch awake', async () => {
    let releaseFirst: () => void = () => {}
    mocks.state.shutdownWorktreeBrowsers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )

    const run = runSleepWorktrees(['wt-1', 'wt-2'])
    await Promise.resolve()
    // Why: the user clicked wt-2 while wt-1 was tearing down; sleeping it anyway
    // must not leave the active workspace marked with no clear pending.
    mocks.state.activeWorktreeId = 'wt-2'
    releaseFirst()
    await run

    expect(mocks.clearWorktreeSleepIntent).toHaveBeenLastCalledWith('wt-2')
  })

  it('marks each worktree only when its own teardown starts', async () => {
    let releaseFirst: () => void = () => {}
    mocks.state.shutdownWorktreeBrowsers.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )

    const run = runSleepWorktrees(['wt-1', 'wt-2'])
    await Promise.resolve()

    // Why: wt-2 is still awake while wt-1 tears down; marking it early would
    // hold its panes cold and swallow its activity.
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.markWorktreeSleepIntent).not.toHaveBeenCalledWith('wt-2')
    releaseFirst()
    await run
    expect(mocks.markWorktreeSleepIntent).toHaveBeenCalledWith('wt-2')
  })

  it('surfaces a toast and skips terminals when browsers throws', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.shutdownWorktreeBrowsers.mockRejectedValueOnce(new Error('boom'))
    mocks.state.tabsByWorktree = { 'wt-1': [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': ['pty-1'] }

    await runSleepWorktree('wt-1')

    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalled()
    expect(mocks.suspendWorkspace).not.toHaveBeenCalled()
    expect(mocks.clearWorktreeSleepIntent).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.setActiveWorktree).toHaveBeenLastCalledWith('wt-1')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({
        description:
          'The workspace was kept open. Try again; if the problem continues, check the host connection.'
      })
    )
  })

  it('restores the active workspace when terminal convergence fails', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.shutdownWorktreeTerminals.mockRejectedValueOnce(
      new Error('terminal_worktree_sleep_still_live')
    )

    await runSleepWorktree('wt-1')

    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null], ['wt-1']])
    expect(mocks.suspendWorkspace).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep workspace',
      expect.objectContaining({
        description:
          'The host could not confirm terminal shutdown. The workspace was kept open; check the connection and try again.'
      })
    )
  })

  it('continues sleeping later worktrees when one selected worktree fails', async () => {
    mocks.state.shutdownWorktreeBrowsers.mockImplementation((worktreeId: string) => {
      if (worktreeId === 'wt-1') {
        return Promise.reject(new Error('first failed'))
      }
      return Promise.resolve()
    })

    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.state.shutdownWorktreeTerminals).not.toHaveBeenCalledWith('wt-1', {
      keepIdentifiers: true
    })
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledWith('wt-2')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-2', {
      keepIdentifiers: true
    })
    expect(mocks.suspendWorkspace).toHaveBeenCalledWith({ workspaceId: 'wt-2' })
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Failed to sleep some workspaces',
      expect.objectContaining({
        description:
          'The workspace was kept open. Try again; if the problem continues, check the host connection.'
      })
    )
  })

  it('reports failed worktrees to a caller that answers for them, without a toast', async () => {
    mocks.state.shutdownWorktreeBrowsers.mockImplementation((worktreeId: string) =>
      worktreeId === 'wt-1' ? Promise.reject(new Error('first failed')) : Promise.resolve()
    )

    mocks.state.unifiedTabsByWorktree = { 'wt-2': [chat('a', 'wt-2', 'local')] }
    mocks.callChat.mockResolvedValue({ stoppedSessionIds: ['session-a'] })

    const outcome = await sleepWorktreesReportingFailures(['wt-1', 'wt-2'])

    expect(outcome.failedWorktreeIds).toEqual(['wt-1'])
    expect(outcome.errors).toHaveLength(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
    // A project move pauses through this core; only the user's Sleep records chats asleep.
    expect(mocks.state.markWorkspaceChatsSlept).not.toHaveBeenCalled()
    expect(mocks.state.clearWorkspaceChatsSlept).not.toHaveBeenCalled()
  })

  it('sleeps multiple worktrees and clears active only once when included', async () => {
    mocks.state.activeWorktreeId = 'wt-2'

    await runSleepWorktrees(['wt-1', 'wt-2'])

    expect(mocks.state.setActiveWorktree).toHaveBeenCalledTimes(1)
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenNthCalledWith(1, 'wt-1')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenNthCalledWith(1, 'wt-1', {
      keepIdentifiers: true
    })
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenNthCalledWith(2, 'wt-2')
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenNthCalledWith(2, 'wt-2', {
      keepIdentifiers: true
    })
    expect(mocks.suspendWorkspace).toHaveBeenNthCalledWith(1, { workspaceId: 'wt-1' })
    expect(mocks.suspendWorkspace).toHaveBeenNthCalledWith(2, { workspaceId: 'wt-2' })
  })

  const twinId = 'repo-1::/wt'
  const twinRows = {
    'repo-1': [
      { id: twinId, repoId: 'repo-1', hostId: 'local' },
      { id: twinId, repoId: 'repo-1', hostId: 'runtime:env-a' }
    ]
  }

  it("stops a workspace's chats on every host that publishes a copy", async () => {
    mocks.state.worktreesByRepo = twinRows
    mocks.state.tabsByWorktree = { [twinId]: [{ id: 'tab-1' }] }
    mocks.state.ptyIdsByTabId = { 'tab-1': [toRemoteRuntimePtyId('pty-1', 'env-a')] }
    mocks.state.unifiedTabsByWorktree = {
      [twinId]: [
        chat('local', twinId, 'local'),
        chat('environment', twinId, 'runtime:env-a'),
        chat('unconfirmed', twinId, 'runtime:env-a')
      ]
    }
    mocks.callChat.mockImplementation(async (target: { kind: string }) => ({
      stoppedSessionIds: [`session-${target.kind}`]
    }))

    const results = await runSleepWorktrees([twinId])

    expect(results).toEqual([
      expect.objectContaining({ executionHostId: 'local', stoppedSessionIds: ['session-local'] }),
      expect.objectContaining({
        executionHostId: 'runtime:env-a',
        stoppedSessionIds: ['session-environment'],
        completed: true
      })
    ])
    // Only chats a host confirmed stopped are recorded, each under its own host.
    expect(mocks.state.markWorkspaceChatsSlept.mock.calls).toEqual([
      [twinId, 'local', [{ tabId: 'local', sessionId: 'session-local' }]],
      [twinId, 'runtime:env-a', [{ tabId: 'environment', sessionId: 'session-environment' }]]
    ])
  })

  it('records nothing when the workspace wakes during the chat stop', async () => {
    mocks.state.unifiedTabsByWorktree = { 'wt-1': [chat('a', 'wt-1', 'local')] }
    mocks.callChat.mockResolvedValue({ stoppedSessionIds: ['session-a'] })
    mocks.hasWorktreeSleepIntent.mockReturnValue(false)

    const results = await runSleepWorktree('wt-1')

    expect(results).toEqual([expect.objectContaining({ completed: false })])
    expect(mocks.state.markWorkspaceChatsSlept).not.toHaveBeenCalled()
  })

  it('stops no chat when it cannot tell which copy runs the terminals', async () => {
    mocks.state.worktreesByRepo = twinRows
    mocks.state.shutdownWorktreeTerminals.mockRejectedValueOnce(
      new Error('ambiguous_terminal_owner')
    )

    await runSleepWorktree(twinId)

    expect(mocks.callChat).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
  })

  it('reports an unconfirmed chat stop in one toast and keeps stopped terminals asleep', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.callChat.mockRejectedValue(new Error('host offline'))

    const results = await runSleepWorktree('wt-1')

    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalled()
    expect(mocks.clearWorktreeSleepIntent).not.toHaveBeenCalled()
    expect(mocks.state.setActiveWorktree.mock.calls).toEqual([[null]])
    expect(results).toEqual([])
    // A Sleep that can't confirm its chats leaves the workspace awake on every host.
    expect(mocks.state.clearWorkspaceChatsSlept).toHaveBeenCalledWith('wt-1')
    expect(mocks.state.markWorkspaceChatsSlept).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to sleep workspace', {
      description:
        'The host could not confirm the chat stopped. Other panels may have closed; check the connection and try again.'
    })
  })

  it('sleeps a workspace named by both copies of a twin once', async () => {
    await runSleepWorktrees(['wt-1', 'wt-1'])

    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledTimes(1)
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledTimes(1)
  })
})
