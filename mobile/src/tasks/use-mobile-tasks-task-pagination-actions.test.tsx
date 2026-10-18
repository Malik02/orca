import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  return {
    useCallback: react.useCallback,
    useMemo: react.useMemo,
    ...(await import('../../../src/shared/work-items'))
  }
})
vi.mock('./mobile-tasks-legacy-foundation', () => ({
  buildPartialRepositoryNotice: () => 'partial'
}))
vi.mock('./mobile-task-list-operations', () => ({ linearAccountConnect: {} }))

import { useMobileTasksTaskPaginationActions } from './use-mobile-tasks-task-pagination-actions'
import type { TaskListLoadingModel } from './use-mobile-tasks-task-list-loading'

const client = { id: 'client' }
const firstPage = [{ key: 'github:repo-1:issue:40', updatedAt: '2026-10-02T00:00:00Z' }]
const oldSelectionPage = [{ key: 'github:repo-1:issue:4', updatedAt: '2026-10-01T00:00:00Z' }]

function buildModel(fetchGitHubItemsPage: () => Promise<unknown>) {
  return {
    client,
    clientRef: { current: client },
    connState: 'connected',
    fetchGitHubItemsPage: vi.fn(fetchGitHubItemsPage),
    githubCurrentPage: 0,
    githubPages: [firstPage],
    githubPaginationLoading: false,
    githubCountedTotalPages: 2,
    loadGenerationRef: { current: 1 },
    selectedHostedRepos: [{ id: 'repo-1' }],
    tasksSupported: true,
    taskUiReady: true,
    setError: vi.fn(),
    setGithubCurrentPage: vi.fn(),
    setGithubLoadingTargetPage: vi.fn(),
    setGithubPages: vi.fn(),
    setGithubPaginationLoading: vi.fn(),
    setItems: vi.fn()
  }
}

let renderer: ReactTestRenderer | null = null
let changePage: ((page: number) => Promise<void>) | null = null

function mount(model: ReturnType<typeof buildModel>): void {
  function Harness(): null {
    changePage = useMobileTasksTaskPaginationActions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries every member the page handler reads.
      model as unknown as TaskListLoadingModel
    ).handleGitHubPageChange
    return null
  }
  act(() => {
    renderer = create(createElement(Harness))
  })
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  changePage = null
})

describe('GitHub task page change', () => {
  it('asks for the target page by number and shows it', async () => {
    const model = buildModel(async () => ({
      items: oldSelectionPage,
      failedCount: 0
    }))
    mount(model)
    await act(async () => {
      await changePage?.(1)
    })
    expect(model.fetchGitHubItemsPage).toHaveBeenCalledWith(client, model.selectedHostedRepos, 1)
    expect(model.setGithubPages).toHaveBeenCalledWith([firstPage, oldSelectionPage])
    expect(model.setItems).toHaveBeenCalledWith(oldSelectionPage)
  })

  it('drops a page that lands after the list reloaded for a new selection', async () => {
    let land: (page: unknown) => void = () => {}
    const model = buildModel(
      () =>
        new Promise((resolve) => {
          land = resolve
        })
    )
    mount(model)
    let pending: Promise<void> | undefined
    act(() => {
      pending = changePage?.(1)
    })
    // The repo picker changed: loadTasks bumps the generation and loads the new list.
    model.loadGenerationRef.current += 1
    await act(async () => {
      land({ items: oldSelectionPage, failedCount: 0 })
      await pending
    })
    expect(model.setGithubPages).not.toHaveBeenCalled()
    expect(model.setItems).not.toHaveBeenCalled()
    expect(model.setGithubPaginationLoading).toHaveBeenLastCalledWith(false)
  })
})
