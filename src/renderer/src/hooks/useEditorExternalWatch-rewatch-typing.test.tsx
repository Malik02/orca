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
  const holder: { store: { getState: () => unknown } | null } = { store: null }
  return {
    keyOf: (target: TestWatchTarget): string => `${target.worktreeId}::client`,
    targets,
    unwatched,
    holder,
    readRuntimeFileContent: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(harness.holder.store?.getState()),
    { getState: () => harness.holder.store?.getState() }
  )
}))
vi.mock('./editor-external-watch-targets', () => ({
  selectEditorExternalWatchTargets: () => ({
    targets: [...harness.targets],
    targetsKey: harness.targets.map(harness.keyOf).join('|'),
    unwatchedTargetKeys: new Set(harness.unwatched.map(harness.keyOf)),
    unwatchedTargetsKey: harness.unwatched.map(harness.keyOf).join('|')
  }),
  getEditorExternalWatchTargetKey: harness.keyOf,
  getOpenFileRuntimeOwner: (file: { runtimeEnvironmentId?: string }) =>
    file.runtimeEnvironmentId?.trim() || null,
  getLocalWindowsWslAliasOption: () => ({})
}))
vi.mock('./editor-external-watch-event-reconciliation', () => ({
  buildEditorExternalWatchEventHandler: () => ({ handleFsChanged: vi.fn(), dispose: vi.fn() })
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  verifyLatchedEditorMoveDestinations: vi.fn()
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: harness.readRuntimeFileContent
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: () => undefined }))

import { createTestStore } from '@/store/slices/store-test-helpers'
import { useEditorExternalWatch } from './useEditorExternalWatch'
import { attachRestoredTabConflictScan } from '@/components/editor/editor-restored-tab-conflict-scan'
import { getDiskBaselineSignature } from '@/components/editor/diff-content-signature'
import {
  isAutosaveSuspendedForFile,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT
} from '@/components/editor/editor-autosave'

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
const FILE = '/background/a.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('typing in a re-watched workspace before its reload lands', () => {
  let store: ReturnType<typeof createTestStore>
  let container: HTMLDivElement
  let root: Root
  let previousApi: unknown
  let detachScan: () => void
  let resolveWatch: () => void
  let reloadEvents: string[]

  const file = () => store.getState().openFiles.find((f) => f.id === FILE)!
  const onReload = (event: Event): void => {
    if (event instanceof CustomEvent) {
      reloadEvents.push(event.detail.relativePath)
    }
  }

  async function render(targets: TestWatchTarget[], unwatched: TestWatchTarget[]): Promise<void> {
    harness.targets.splice(0, harness.targets.length, ...targets)
    harness.unwatched.splice(0, harness.unwatched.length, ...unwatched)
    await act(async () => root.render(createElement(WatchProbe)))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reloadEvents = []
    store = createTestStore()
    harness.holder.store = store
    store.getState().openFile({
      filePath: FILE,
      relativePath: 'a.ts',
      worktreeId: 'background',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setLastKnownDiskSignature(FILE, getDiskBaselineSignature('v1'))
    previousApi = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api: unknown }).api = {
      fs: {
        watchWorktree: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveWatch = resolve
            })
        ),
        unwatchWorktree: vi.fn().mockResolvedValue(undefined),
        onFsChanged: vi.fn(() => vi.fn()),
        pathExists: vi.fn().mockResolvedValue(true)
      }
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onReload)
    detachScan = attachRestoredTabConflictScan(store)
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    detachScan()
    window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onReload)
    container.remove()
    ;(window as unknown as { api?: unknown }).api = previousApi
  })

  async function switchBackAndType(): Promise<void> {
    await render([active], [background])
    await render([active, background], [])
    // Why: the clean tab is armed before the edit, so the edit itself starts the disk check.
    expect(file().pendingDiskBaselineVerification).toBe(true)
    store.getState().setEditorDraft(FILE, 'typed while the watch installs')
    store.getState().markFileDirty(FILE, true)
  }

  it('holds autosave and shows changed-on-disk when the file changed while unwatched', async () => {
    const read = deferred<{ content: string; isBinary: boolean }>()
    harness.readRuntimeFileContent.mockReturnValue(read.promise)
    await switchBackAndType()

    expect(isAutosaveSuspendedForFile(file())).toBe(true)
    await act(async () => read.resolve({ content: 'v2 written by an agent', isBinary: false }))
    expect(file().externalMutation).toBe('changed')
    expect(isAutosaveSuspendedForFile(file())).toBe(true)

    await act(async () => resolveWatch())
    expect(reloadEvents).toEqual([])
    expect(file().isDirty).toBe(true)
  })

  it('releases autosave without a banner when disk still matches', async () => {
    harness.readRuntimeFileContent.mockResolvedValue({ content: 'v1', isBinary: false })
    await switchBackAndType()
    await act(async () => resolveWatch())

    expect(file().externalMutation).toBeUndefined()
    expect(isAutosaveSuspendedForFile(file())).toBe(false)
    expect(reloadEvents).toEqual([])
  })

  it('reloads the tab when it stays clean until the watch is live', async () => {
    await render([active], [background])
    await render([active, background], [])
    await act(async () => resolveWatch())

    expect(reloadEvents).toEqual(['a.ts'])
    expect(harness.readRuntimeFileContent).not.toHaveBeenCalled()
  })
})
