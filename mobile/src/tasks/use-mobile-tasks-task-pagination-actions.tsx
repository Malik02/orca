import type { TaskListLoadingModel } from './use-mobile-tasks-task-list-loading'
import {
  CROSS_REPO_DISPLAY_LIMIT,
  PER_REPO_FETCH_LIMIT,
  getTaskPagePerRepoLimit,
  useCallback,
  useMemo
} from './mobile-tasks-dependencies'
import { buildPartialRepositoryNotice } from './mobile-tasks-legacy-foundation'
import { linearAccountConnect } from './mobile-task-list-operations'

export function useMobileTasksTaskPaginationActions(model: TaskListLoadingModel) {
  const {
    client,
    clientRef,
    connState,
    fetchGitHubItemsPage,
    githubCurrentPage,
    githubPages,
    githubPaginationLoading,
    githubCountedTotalPages,
    linearApiKeyDraft,
    linearConnectState,
    loadGenerationRef,
    loadLinearContext,
    loadTasks,
    selectedHostedRepos,
    setError,
    setGithubCurrentPage,
    setGithubLoadingTargetPage,
    setGithubPages,
    setGithubPaginationLoading,
    setItems,
    setLinearApiKeyDraft,
    setLinearConnectError,
    setLinearConnectState,
    setLinearConnected,
    setProvider,
    setRetryingGithubSourceRepoPaths,
    setShowLinearConnect,
    setVisibleProviders,
    taskUiReady,
    tasksSupported
  } = model
  const connectLinearAccount = useCallback(async (): Promise<void> => {
    if (!client || connState !== 'connected' || !taskUiReady) {
      return
    }
    const apiKey = linearApiKeyDraft.trim()
    if (!apiKey || linearConnectState === 'connecting') {
      return
    }
    setLinearConnectState('connecting')
    setLinearConnectError('')
    try {
      const reply = await linearAccountConnect.request(client, { apiKey })
      const result = linearAccountConnect.interpret(reply)
      if (result.ok === false) {
        throw new Error(result.error ?? 'Failed to connect Linear')
      }
      setLinearApiKeyDraft('')
      setLinearConnectState('idle')
      setShowLinearConnect(false)
      setLinearConnected(true)
      setVisibleProviders((current) =>
        current.includes('linear') ? current : [...current, 'linear']
      )
      setProvider('linear')
      await loadLinearContext()
    } catch (err) {
      setLinearConnectState('error')
      setLinearConnectError(err instanceof Error ? err.message : 'Connection failed')
    }
  }, [client, connState, linearApiKeyDraft, linearConnectState, loadLinearContext, taskUiReady])

  const retryGitHubIssueSourceFetch = useCallback(
    async (repoPath: string): Promise<void> => {
      setRetryingGithubSourceRepoPaths((current) => {
        const next = new Set(current)
        next.add(repoPath)
        return next
      })
      try {
        // Why: desktop retries through the shared list refresh path so source
        // errors, rows, counts, and pagination reset from one authoritative fetch.
        await loadTasks({ silent: true })
      } finally {
        setRetryingGithubSourceRepoPaths((current) => {
          const next = new Set(current)
          next.delete(repoPath)
          return next
        })
      }
    },
    [loadTasks]
  )

  // Why: a zero count is a failed count, so it falls back like desktop's deriveAdvertisedTotalPages.
  const githubTotalPages = githubCountedTotalPages
    ? Math.max(githubPages.length, githubCountedTotalPages)
    : githubPages.length
  const githubPageCapacity =
    getTaskPagePerRepoLimit(
      selectedHostedRepos.length,
      PER_REPO_FETCH_LIMIT,
      CROSS_REPO_DISPLAY_LIMIT
    ) * Math.max(1, selectedHostedRepos.length)
  const githubCanLoadUncountedNextPage =
    !githubCountedTotalPages && (githubPages.at(-1)?.length ?? 0) >= githubPageCapacity
  const githubCanShowPagination =
    githubTotalPages > 1 || (githubPages.length > 0 && githubCanLoadUncountedNextPage)
  const githubPagePickerPages = useMemo(() => {
    const visible = new Set<number>()
    const availablePages = Math.min(
      githubTotalPages + (githubCanLoadUncountedNextPage ? 1 : 0),
      githubPages.length + (githubCanLoadUncountedNextPage ? 1 : 0)
    )
    for (let index = 0; index < availablePages; index += 1) {
      visible.add(index)
    }
    for (
      let index = Math.max(0, githubCurrentPage - 2);
      index <= Math.min(availablePages - 1, githubCurrentPage + 2);
      index += 1
    ) {
      visible.add(index)
    }
    return [...visible].sort((a, b) => a - b)
  }, [githubCanLoadUncountedNextPage, githubCurrentPage, githubTotalPages])

  const handleGitHubPageChange = useCallback(
    async (targetPage: number): Promise<void> => {
      if (
        !client ||
        !tasksSupported ||
        targetPage < 0 ||
        githubPaginationLoading ||
        selectedHostedRepos.length === 0
      ) {
        return
      }
      if (targetPage > githubPages.length) {
        return
      }
      if (targetPage < githubPages.length) {
        setGithubCurrentPage(targetPage)
        setItems(githubPages[targetPage] ?? [])
        return
      }
      // Why: as on desktop, a list reload (selection, query, provider, refresh) supersedes this
      // page; its rows belong to the old list and must not land on the new one.
      const generation = loadGenerationRef.current
      const isCurrent = () =>
        loadGenerationRef.current === generation && clientRef.current === client
      setGithubPaginationLoading(true)
      setGithubLoadingTargetPage(targetPage)
      try {
        const page = await fetchGitHubItemsPage(client, selectedHostedRepos, targetPage)
        if (!isCurrent() || page.items.length === 0) {
          return
        }
        if (page.failedCount > 0) {
          setError(buildPartialRepositoryNotice(page.failedCount, selectedHostedRepos.length))
        }
        setGithubPages([...githubPages, page.items])
        setGithubCurrentPage(targetPage)
        setItems(page.items)
      } catch (err) {
        if (isCurrent()) {
          setError(err instanceof Error ? err.message : 'Failed to load more GitHub tasks')
        }
      } finally {
        // Why: always clear — the page controls stay disabled while this runs, so no newer page
        // fetch can own the loading state.
        setGithubPaginationLoading(false)
        setGithubLoadingTargetPage(null)
      }
    },
    [
      client,
      clientRef,
      fetchGitHubItemsPage,
      githubPages,
      githubPaginationLoading,
      loadGenerationRef,
      selectedHostedRepos,
      tasksSupported
    ]
  )
  return Object.assign(model, {
    connectLinearAccount,
    retryGitHubIssueSourceFetch,
    githubTotalPages,
    githubPageCapacity,
    githubCanLoadUncountedNextPage,
    githubCanShowPagination,
    githubPagePickerPages,
    handleGitHubPageChange
  })
}

export type TaskPaginationActionsModel = ReturnType<typeof useMobileTasksTaskPaginationActions>
