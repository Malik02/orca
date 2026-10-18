import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getState, scheduleReload } = vi.hoisted(() => ({
  getState: vi.fn(),
  scheduleReload: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('./editor-external-watch-disk-verification', () => ({
  scheduleDebouncedEditorExternalReload: scheduleReload
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
  tab('clean.ts'),
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

  beforeEach(() => {
    vi.clearAllMocks()
    getState.mockReturnValue({ setPendingDiskBaselineVerification, openFiles })
  })

  it('hands only scan-eligible dirty tabs of the workspace to the conflict scan', () => {
    armEditorTabDiskVerification(target)

    expect(setPendingDiskBaselineVerification).toHaveBeenCalledTimes(1)
    expect(setPendingDiskBaselineVerification).toHaveBeenCalledWith('dirty.ts', true)
    expect(scheduleReload).not.toHaveBeenCalled()
  })

  it('reloads clean file tabs but skips deleted, renamed, combined-diff and virtual tabs', () => {
    reloadCleanEditorTabs(target)

    expect(scheduleReload.mock.calls.map(([call]) => call.relativePath)).toEqual([
      'clean.ts',
      'preview.md',
      'staged.ts'
    ])
    expect(scheduleReload).toHaveBeenCalledWith({
      worktreeId: 'wt',
      worktreePath: '/repo',
      relativePath: 'clean.ts',
      runtimeEnvironmentId: null
    })
    expect(setPendingDiskBaselineVerification).not.toHaveBeenCalled()
  })

  it('scopes the reload to the target host owner', () => {
    reloadCleanEditorTabs({ ...target, runtimeEnvironmentId: 'env-1' })

    expect(scheduleReload).toHaveBeenCalledTimes(1)
    expect(scheduleReload).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'runtime.ts', runtimeEnvironmentId: 'env-1' })
    )
  })
})
