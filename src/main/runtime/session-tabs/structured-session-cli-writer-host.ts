import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { OrcaRuntimeWithGetWorktreePs } from '../workspaces/workspace-process-listing'
import { getProviderForPty } from '../../ipc/pty/provider/registry'
import { LocalPtyProvider } from '../../providers/local-pty-provider'
import { inspectPtyProviderProcess } from '../../providers/pty-process-inspection'
import { inspectionShowsShellAlone } from '../run-terminal-shell-alone'
import {
  assertCliConversationWritersExited,
  posixCliWriterShellAlone,
  type CliWriterPane,
  type CliWriterTerminal
} from '../structured-agent-cli-writers'

export abstract class OrcaRuntimeWithStructuredSessionCliWriterHost extends OrcaRuntimeWithGetWorktreePs {
  protected cliWriterTerminal(coordinates: {
    paneKey: string
    worktreeId?: string
  }): CliWriterTerminal | null {
    const record = this.getPtyRecordForPaneKey(coordinates.paneKey)
    if (!record || this.getPtyLivenessVerdict(record.ptyId)?.status === 'exited') {
      return null
    }
    try {
      const pane = this.resolveTerminalPane(coordinates.paneKey, coordinates.worktreeId ?? '')
      const pty = pane.ptyId ? this.ptysById.get(pane.ptyId) : undefined
      const handle = this.getAgentStatusTerminalHandleForPaneKey(coordinates.paneKey)
      const incarnation = handle ? this.getTerminalProcessIncarnation(handle) : null
      const execution = handle && incarnation ? `${handle}:${incarnation}` : null
      return {
        execution,
        pane:
          execution && pty?.connected && !pty.connectionId && !pty.isWsl && pty.incarnationId
            ? {
                ptyId: pty.ptyId,
                incarnationId: pty.incarnationId,
                identity: `${execution}:${pty.incarnationId}`
              }
            : null
      }
    } catch {
      return { execution: null, pane: null }
    }
  }

  protected cliWriterPane(
    row: Pick<AgentStatusIpcPayload, 'paneKey' | 'worktreeId'>
  ): CliWriterPane | null {
    const observed = this.readObservedAgentStatusPaneIdentityFn(row.paneKey)
    const terminal = this.cliWriterTerminal(row)
    return observed.kind === 'observed' &&
      terminal?.execution === `${observed.terminalHandle}:${observed.processIncarnation}`
      ? terminal.pane
      : null
  }

  async assertStructuredAdoptionTerminalWritersExited(
    agent: StructuredAgentId,
    providerSessionId: string,
    source?: { workspaceId: string; paneKey: string }
  ): Promise<void> {
    await assertCliConversationWritersExited(
      {
        rows: () => this.getAgentProviderSessionRows(),
        saved: () =>
          Object.values(
            this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)
              ?.sleepingAgentSessionsByPaneKey ?? {}
          ),
        observation: (row) => this.readHookCliWriterObservationFn?.(row) ?? null,
        pane: (row) => this.cliWriterPane(row),
        terminal: (coordinates) => this.cliWriterTerminal(coordinates),
        links: () =>
          [
            ...new Map(
              [...this.ptysById.values()].map((pty) => [pty.paneKey ?? '', pty.worktreeId] as const)
            )
          ].flatMap(([paneKey, worktreeId]) => {
            const observed = this.readObservedAgentStatusPaneIdentityFn(paneKey)
            return observed.kind === 'observed'
              ? [...(observed.conversations?.values() ?? [])].map((conversation) => ({
                  ...conversation,
                  paneKey,
                  worktreeId,
                  execution: `${observed.terminalHandle}:${observed.processIncarnation}`
                }))
              : []
          }),
        sleeping: (workspaceId) =>
          [...this.terminalSleepStateByWorktreeId.values()].some(
            (state) =>
              state.worktreeId === workspaceId &&
              (state.phase === 'sleeping' ||
                state.phase === 'partial' ||
                state.phase === 'stopping')
          ),
        shellAlone: async (pane) => {
          if (process.platform === 'win32') {
            const provider = getProviderForPty(pane.ptyId)
            const inspection = await inspectPtyProviderProcess(provider, pane.ptyId, {
              expectedIncarnationId: pane.incarnationId,
              scanChildProcesses: true
            })
            const evidence = inspection.foregroundProcessEvidence
            return (
              inspectionShowsShellAlone(inspection) &&
              (provider instanceof LocalPtyProvider ||
                (evidence?.ptyId === pane.ptyId &&
                  evidence.ptyIncarnationId === pane.incarnationId &&
                  evidence.verdict === 'unverifiable' &&
                  evidence.reason === 'windows_ssh_foreground_unavailable'))
            )
          }
          const processes = await this.ptyController?.listProcesses?.(LOCAL_EXECUTION_HOST_ID)
          const entry = processes?.find((candidate) => candidate.id === pane.ptyId)
          const pty = this.ptysById.get(pane.ptyId)
          return (
            !!entry?.rootProcessId &&
            !!entry.incarnationId &&
            entry.incarnationId === pty?.incarnationId &&
            (await posixCliWriterShellAlone(entry.rootProcessId))
          )
        }
      },
      agent,
      providerSessionId,
      source && { paneKey: source.paneKey, worktreeId: source.workspaceId }
    )
  }
}
