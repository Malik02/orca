import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EditorAutosave from '@/components/editor/editor-autosave'

const { getState, notify, probeMissing } = vi.hoisted(() => ({
  getState: vi.fn(),
  notify: vi.fn(),
  probeMissing: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof EditorAutosave>()),
  notifyEditorExternalFileChange: notify
}))
vi.mock('@/components/editor/editor-restored-tab-conflict-scan', () => ({
  probeEditorTabFileMissing: probeMissing
}))

import {
  armEditorTabDiskVerification,
  reloadCleanEditorTabs
} from './editor-external-watch-rewatch-reload'

const target = {
  worktreeId: 'wt',
  worktreePath: '/repo',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

function tab(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    worktreeId: 'wt',
    filePath: `/repo/${id}`,
    relativePath: id,
    mode: 'edit',
    isDirty: false,
    ...extra
  }
}

const openFiles = [
  tab('dirty.ts', { isDirty: true, lastKnownDiskSignature: 'sig' }),
  tab('clean.ts', { lastKnownDiskSignature: 'sig' }),
  tab('preview.md', { mode: 'markdown-preview' }),
  tab('staged.ts', { mode: 'diff', diffSource: 'staged' }),
  tab('deleted.ts', { externalMutation: 'deleted' }),
  tab('renamed.ts', { externalMutation: 'renamed' }),
  tab('combined', { mode: 'diff', diffSource: 'combined-uncommitted' }),
  tab('checks', { mode: 'check-details' }),
  tab('no-baseline.ts', { isDirty: true }),
  tab('already-changed.ts', {
    isDirty: true,
    lastKnownDiskSignature: 'sig',
    externalMutation: 'changed'
  }),
  tab('other.ts', { worktreeId: 'other', lastKnownDiskSignature: 'sig' }),
  tab('runtime.ts', { runtimeEnvironmentId: 'env-1' })
]

describe('re-reading tabs after a dropped watch returns', () => {
  const setPendingDiskBaselineVerification = vi.fn()
  const clearPendingDiskBaselineVerification = vi.fn()
  const setExternalMutation = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    probeMissing.mockResolvedValue(false)
    getState.mockReturnValue({
      setPendingDiskBaselineVerification,
      clearPendingDiskBaselineVerification,
      setExternalMutation,
      openFiles,
      gitStatusByWorktree: { wt: [{ path: 'dirty.ts' }, { path: 'only-in-status.ts' }] }
    })
  })

  it('arms clean and dirty scan-eligible tabs so a later edit waits for the disk check', () => {
    armEditorTabDiskVerification(target)

    expect(setPendingDiskBaselineVerification.mock.calls).toEqual([
      ['dirty.ts', true],
      ['clean.ts', true]
    ])
    expect(notify).not.toHaveBeenCalled()
  })

  it('reloads clean file tabs but skips deleted, renamed, combined-diff and virtual tabs', async () => {
    await reloadCleanEditorTabs(target)

    const paths = notify.mock.calls.map(([call]) => call.relativePath)
    expect(paths).toEqual(expect.arrayContaining(['clean.ts', 'preview.md', 'staged.ts']))
    for (const skipped of ['deleted.ts', 'renamed.ts', 'combined', 'checks', 'other.ts']) {
      expect(paths).not.toContain(skipped)
    }
    expect(notify).toHaveBeenCalledWith({
      worktreeId: 'wt',
      worktreePath: '/repo',
      relativePath: 'clean.ts',
      runtimeEnvironmentId: null
    })
    expect(setPendingDiskBaselineVerification).not.toHaveBeenCalled()
  })

  it('replays git status paths for combined diffs, never touching a dirty tab', async () => {
    await reloadCleanEditorTabs(target)

    const paths = notify.mock.calls.map(([call]) => call.relativePath)
    expect(paths).toContain('only-in-status.ts')
    expect(paths).not.toContain('dirty.ts')
  })

  it('marks a file removed while unwatched as deleted instead of reloading it', async () => {
    probeMissing.mockImplementation(async (_state, file) => file.id === 'clean.ts')
    await reloadCleanEditorTabs(target)

    expect(setExternalMutation).toHaveBeenCalledWith('clean.ts', 'deleted')
    expect(clearPendingDiskBaselineVerification).toHaveBeenCalledWith('clean.ts')
    expect(notify.mock.calls.map(([call]) => call.relativePath)).not.toContain('clean.ts')
  })

  it('scopes the reload to the target host owner', async () => {
    getState.mockReturnValue({ openFiles, gitStatusByWorktree: {} })
    await reloadCleanEditorTabs({ ...target, runtimeEnvironmentId: 'env-1' })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'runtime.ts', runtimeEnvironmentId: 'env-1' })
    )
  })
})
