import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const mockState = vi.hoisted(() => {
  const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
  return { agentStatusByPaneKey, dropAgentStatus: vi.fn() }
})

import {
  armLateProgramResult,
  dismissRetainedProgramResult,
  forgetProgramResult,
  forgetProgramResultsForTab,
  retainIfProgramResult
} from './result-retention'

const PANE = 'tab-1:leaf-1'

function programDone(stateStartedAt: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    agentType: 'brew',
    paneKey: PANE,
    updatedAt: stateStartedAt,
    stateStartedAt,
    stateHistory: [],
    programStatus: { state: 'done', observedAt: stateStartedAt }
  }
}

describe('program status result retention', () => {
  beforeEach(() => {
    mockState.agentStatusByPaneKey = {}
    mockState.dropAgentStatus.mockClear()
    forgetProgramResult(PANE)
  })

  it('retains only a finished program result', () => {
    expect(retainIfProgramResult(PANE, programDone(1_000))).toBe(true)
    expect(retainIfProgramResult(PANE, { ...programDone(1_000), agentType: 'claude' })).toBe(false)
    expect(retainIfProgramResult(PANE, { ...programDone(1_000), sessionBoundary: true })).toBe(
      false
    )
  })

  it('dismisses the stamped result it retained', () => {
    const entry = programDone(1_000)
    mockState.agentStatusByPaneKey[PANE] = entry
    retainIfProgramResult(PANE, entry)

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).toHaveBeenCalledWith(PANE)
  })

  it('never drops a newer report than the stamped one', () => {
    retainIfProgramResult(PANE, programDone(1_000))
    mockState.agentStatusByPaneKey[PANE] = programDone(2_000)

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it("lets 'late' clear whichever program result lands after the command finished", () => {
    armLateProgramResult(PANE)
    mockState.agentStatusByPaneKey[PANE] = programDone(3_000)

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).toHaveBeenCalledWith(PANE)
  })

  it("leaves a real agent's row alone even when armed 'late'", () => {
    armLateProgramResult(PANE)
    mockState.agentStatusByPaneKey[PANE] = { ...programDone(3_000), agentType: 'claude' }

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('dismisses at most once', () => {
    armLateProgramResult(PANE)
    dismissRetainedProgramResult(PANE, mockState)
    mockState.agentStatusByPaneKey[PANE] = programDone(3_000)

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('forgets a closed pane so a later dismissal is a no-op', () => {
    armLateProgramResult(PANE)
    forgetProgramResult(PANE)
    mockState.agentStatusByPaneKey[PANE] = programDone(3_000)

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).not.toHaveBeenCalled()
  })

  it("forgets every pane of a retired tab, and only that tab's", () => {
    const sibling = 'tab-10:leaf-1'
    armLateProgramResult(PANE)
    armLateProgramResult(sibling)
    forgetProgramResultsForTab('tab-1')
    mockState.agentStatusByPaneKey[PANE] = programDone(4_000)
    mockState.agentStatusByPaneKey[sibling] = { ...programDone(4_000), paneKey: sibling }

    dismissRetainedProgramResult(PANE, mockState)
    expect(mockState.dropAgentStatus).not.toHaveBeenCalled()
    dismissRetainedProgramResult(sibling, mockState)
    expect(mockState.dropAgentStatus).toHaveBeenCalledWith(sibling)
  })
})
