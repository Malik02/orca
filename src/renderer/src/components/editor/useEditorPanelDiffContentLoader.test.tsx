// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { DiffContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({
  getRuntimeGitDiff: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: mocks.getRuntimeGitDiff
}))
vi.mock('@/runtime/runtime-git-client-context', () => ({ getRuntimeGitScope: vi.fn(() => null) }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdForFile: vi.fn(() => undefined) }))
vi.mock('@/lib/file-owner-runtime-target', () => ({
  requireRuntimeTargetForFileOwner: () => ({ kind: 'local' })
}))

import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import { getDiskBaselineSignature } from './diff-content-signature'

async function loadDiff(file: OpenFile): Promise<void> {
  let load: ((file: OpenFile) => Promise<void>) | null = null
  function Probe(): null {
    load = useEditorPanelDiffContentLoader({
      diffReadGenerationCounterRef: { current: 0 },
      diffReadGenerationRef: { current: {} },
      outstandingDiffReadsRef: { current: {} },
      setDiffContents: (_next: unknown) => {}
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  await act(async () => load?.(file))
  root.unmount()
}

const diff: DiffContent = {
  kind: 'text',
  originalContent: 'head',
  modifiedContent: 'working tree',
  originalIsBinary: false,
  modifiedIsBinary: false
}

describe('diff tab disk baseline', () => {
  it.each([
    ['unstaged', true],
    ['staged', false]
  ] as const)(
    'stamps a clean %s diff tab from its working-tree side: %s',
    async (diffSource, stamps) => {
      const file: OpenFile = {
        id: '/repo/a.ts',
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt',
        language: 'typescript',
        isDirty: false,
        mode: 'diff',
        diffSource
      }
      const setLastKnownDiskSignature = vi.fn()
      const clearPendingDiskBaselineVerification = vi.fn()
      mocks.getState.mockReturnValue({
        openFiles: [file],
        setLastKnownDiskSignature,
        clearPendingDiskBaselineVerification
      })
      mocks.getRuntimeGitDiff.mockResolvedValue(diff)

      await loadDiff(file)

      if (stamps) {
        expect(setLastKnownDiskSignature).toHaveBeenCalledWith(
          file.id,
          getDiskBaselineSignature('working tree')
        )
        expect(clearPendingDiskBaselineVerification).toHaveBeenCalledWith(file.id)
      } else {
        expect(setLastKnownDiskSignature).not.toHaveBeenCalled()
      }
    }
  )
})
