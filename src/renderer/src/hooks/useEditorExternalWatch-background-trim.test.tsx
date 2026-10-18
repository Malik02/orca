// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
}

const harness = vi.hoisted(() => {
  const targets: TestWatchTarget[] = []
  const unwatched: TestWatchTarget[] = []
  const runtimeReady: { current: (() => void) | undefined } = { current: undefined }
  return {
    keyOf: (target: TestWatchTarget): string =>
      `${target.worktreeId}::${target.runtimeEnvironmentId ?? 'client'}`,
    targets,
    unwatched,
    arm: vi.fn(),
    reload: vi.fn(),
    runtimeUnsubscribe: vi.fn(),
    runtimeReady
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({})
}))
vi.mock('./editor-external-watch-targets', () => ({
  selectEditorExternalWatchTargets: () => ({
    targets: harness.targets,
    targetsKey: harness.targets.map(harness.keyOf).join('|'),
    unwatchedTargetKeys: new Set(harness.unwatched.map(harness.keyOf)),
    unwatchedTargetsKey: harness.unwatched.map(harness.keyOf).join('|')
  }),
  getEditorExternalWatchTargetKey: harness.keyOf
}))
vi.mock('./editor-runtime-file-watch', () => ({
  subscribeEditorRuntimeFileWatch: (
    _target: unknown,
    _onPayload: unknown,
    _onError: unknown,
    onFirstReady?: () => void
  ) => {
    harness.runtimeReady.current = onFirstReady
    return harness.runtimeUnsubscribe
  }
}))
vi.mock('./editor-external-watch-event-reconciliation', () => ({
  buildEditorExternalWatchEventHandler: () => ({ handleFsChanged: vi.fn(), dispose: vi.fn() })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  verifyLatchedEditorMoveDestinations: vi.fn()
}))
vi.mock('./editor-external-watch-rewatch-reload', () => ({
  armEditorTabDiskVerification: harness.arm,
  reloadCleanEditorTabs: harness.reload
}))

import { useEditorExternalWatch } from './useEditorExternalWatch'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

const active: TestWatchTarget = {
  worktreeId: 'active',
  worktreePath: '/active',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const background: TestWatchTarget = {
  worktreeId: 'background',
  worktreePath: '/background',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const runtimeBackground: TestWatchTarget = {
  worktreeId: 'runtime-background',
  worktreePath: '/runtime',
  connectionId: undefined,
  runtimeEnvironmentId: 'env-1'
}

describe('useEditorExternalWatch with background trim', () => {
  let container: HTMLDivElement
  let root: Root
  let previousApi: unknown
  let watchWorktree: ReturnType<typeof vi.fn>
  let unwatchWorktree: ReturnType<typeof vi.fn>
  let resolveWatch: () => void

  async function render(targets: TestWatchTarget[], unwatched: TestWatchTarget[]): Promise<void> {
    harness.targets = targets
    harness.unwatched = unwatched
    await act(async () => root.render(createElement(WatchProbe)))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    watchWorktree = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWatch = resolve
        })
    )
    unwatchWorktree = vi.fn().mockResolvedValue(undefined)
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: { watchWorktree, unwatchWorktree, onFsChanged: vi.fn(() => vi.fn()) }
    }
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  it('re-reads a dropped workspace once its watch is live again', async () => {
    await render([active], [background])
    expect(watchWorktree).toHaveBeenCalledTimes(1)

    await render([active, background], [])
    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/background',
      connectionId: undefined
    })
    expect(harness.arm).toHaveBeenCalledWith(background)
    // Why: the reload waits for the watch install so a write during it is not lost.
    expect(harness.reload).not.toHaveBeenCalled()
    await act(async () => resolveWatch())
    expect(harness.reload).toHaveBeenCalledWith(background)
    expect(harness.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads a dropped runtime workspace only once its host reports the watch ready', async () => {
    await render([active], [runtimeBackground])
    await render([active, runtimeBackground], [])

    expect(harness.arm).toHaveBeenCalledWith(runtimeBackground)
    expect(harness.reload).not.toHaveBeenCalled()
    await act(async () => harness.runtimeReady.current?.())
    expect(harness.reload).toHaveBeenCalledWith(runtimeBackground)
  })

  it('keeps a directory watched while another workspace on it still needs it', async () => {
    const sibling = { ...background, worktreeId: 'sibling' }
    await render([active, background, sibling], [])
    expect(watchWorktree).toHaveBeenCalledTimes(2)

    await render([active, sibling], [background])
    expect(unwatchWorktree).not.toHaveBeenCalled()

    await render([active], [background, sibling])
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/background',
      connectionId: undefined
    })
  })

  it('catches up a re-watched workspace whose directory another workspace already watches', async () => {
    const sibling = { ...background, worktreeId: 'sibling' }
    await render([active, sibling], [background])
    await render([active, sibling, background], [])

    expect(watchWorktree).toHaveBeenCalledTimes(2)
    expect(harness.reload).not.toHaveBeenCalled()
    await act(async () => resolveWatch())
    expect(harness.reload).toHaveBeenCalledWith(background)
  })

  it('does not reload a workspace whose tabs were just opened', async () => {
    await render([active], [])
    await render([active, background], [])
    await act(async () => resolveWatch())

    expect(harness.arm).not.toHaveBeenCalled()
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('sees a tab opened while its workspace was unwatched', async () => {
    await render([active], [])
    // Why: only the unwatched set changes here; the hook must still record it.
    await render([active], [background])
    await render([active, background], [])

    expect(harness.arm).toHaveBeenCalledWith(background)
  })

  it('only releases when a background workspace drops out', async () => {
    await render([active, background], [])
    watchWorktree.mockClear()

    await render([active], [background])
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/background',
      connectionId: undefined
    })
    expect(watchWorktree).not.toHaveBeenCalled()
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('leaves no watch behind after all tabs close or the app unmounts', async () => {
    await render([active, background, runtimeBackground], [])
    await render([], [])
    expect(unwatchWorktree).toHaveBeenCalledTimes(2)
    expect(harness.runtimeUnsubscribe).toHaveBeenCalledTimes(1)

    await render([active], [background])
    await act(async () => root.unmount())
    expect(unwatchWorktree).toHaveBeenCalledTimes(3)
    expect(unwatchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/active',
      connectionId: undefined
    })
    root = createRoot(container)
  })
})
