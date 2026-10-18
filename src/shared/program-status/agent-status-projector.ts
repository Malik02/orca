// Projects OSC 7501 records onto agent-status payloads so they ride the OSC 9999 terminal-status ingress.
import type { AgentStatusState, ParsedAgentStatusPayload } from '../agent-status-types'
import type { AgentSubagentSnapshot, AgentSubagentState } from '../agent-status-subagent-snapshot'
import {
  AGENT_STATUS_MAX_SUBAGENTS,
  AGENT_SUBAGENT_ID_MAX_LENGTH
} from '../agent-status-subagent-snapshot'
import type { AgentTurnOutcome } from '../agent-turn-outcome'
import { createProgramStatusOscScanner } from './osc-scanner'
import {
  programStatusDisplayText,
  programStatusFacetFromRecord,
  programStatusFacetsEqual,
  type ProgramStatusFacet
} from './facet'
import { ProgramStatusRecordSet, type ProgramStatusRecord } from './records'

/** OSC 7501 `app` ids whose Orca agent id differs. Other apps pass through verbatim. */
const APP_TO_AGENT_TYPE: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  'grok-build': 'grok'
}

function agentTypeForProgramStatusApp(app: string | undefined): string | undefined {
  return app === undefined ? undefined : (APP_TO_AGENT_TYPE[app] ?? app)
}

function blockedState(record: ProgramStatusRecord): 'waiting' | 'blocked' {
  // Why: Orca's hooks report approvals and questions as `waiting`; auth and unnamed blocks stay `blocked`.
  return record.kind === 'permission' || record.kind === 'question' ? 'waiting' : 'blocked'
}

function subagentState(record: ProgramStatusRecord): AgentSubagentState | null {
  switch (record.state) {
    case 'working':
      return 'working'
    case 'blocked':
      return blockedState(record)
    case 'idle':
      return 'idle'
    case 'done':
    case 'error':
      // A finished child is not a live child row.
      return null
  }
}

type RootProjection = {
  state: AgentStatusState
  outcome?: AgentTurnOutcome
  sessionBoundary?: true
}

type ProgramStatusRootChange = { offset: number; root: ProgramStatusRecord | undefined }

type ProgramStatusProjector = {
  /** Feed one chunk; returns, in byte order with chunk offsets, the lifecycle payloads it produced and
   *  every root record change (including ones the store would not see as news), plus the chunk's net
   *  facet change: the new facet, `null` once the root record is gone, absent when unchanged. */
  process: (data: string) => {
    payloads: { payload: ParsedAgentStatusPayload; offset: number }[]
    rootChanges: ProgramStatusRootChange[]
    facet?: ProgramStatusFacet | null
  }
}

export function createProgramStatusProjector(now: () => number = Date.now): ProgramStatusProjector {
  const scan = createProgramStatusOscScanner()
  const records = new ProgramStatusRecordSet()
  let lastRoot: RootProjection | null = null
  let lastKey: string | null = null
  let rootStateStartedAt = 0
  let lastFacet: ProgramStatusFacet | undefined
  const childStartedAt = new Map<string, number>()

  const projectRoot = (root: ProgramStatusRecord | undefined): RootProjection | null => {
    const wasActive =
      lastRoot !== null && lastRoot.state !== 'done' && lastRoot.sessionBoundary !== true
    if (!root) {
      // Why a boundary, not a verdict: programs clear on exit (Claude's /exit even reports working
      // first), and a record dropped at the next prompt proves the program ended, not how.
      return wasActive ? { state: 'done', sessionBoundary: true } : null
    }
    switch (root.state) {
      case 'working':
        return { state: 'working' }
      case 'blocked':
        return { state: blockedState(root) }
      case 'done':
        return { state: 'done', outcome: 'success' }
      case 'error':
        return { state: 'done', outcome: 'failure' }
      case 'idle':
        // Why no cancellation verdict: idle also follows startup work (Codex reports a working blip
        // while it boots), so it only proves the program is at rest. Orca infers a user's cancel
        // from the interrupt keystroke itself. Idle after a finished turn keeps the unseen `done`.
        return lastRoot?.state === 'done' && lastRoot.sessionBoundary !== true
          ? lastRoot
          : { state: 'done', sessionBoundary: true }
    }
  }

  const snapshotChildren = (): AgentSubagentSnapshot[] => {
    const at = now()
    const live = new Set<string>()
    const children: AgentSubagentSnapshot[] = []
    for (const record of records.descendants()) {
      const state = subagentState(record)
      if (record.id === null || state === null) {
        continue
      }
      // Keep the suffix: ids are paths, and the leaf names the child.
      const id = record.id.slice(-AGENT_SUBAGENT_ID_MAX_LENGTH)
      live.add(id)
      const startedAt = childStartedAt.get(id) ?? at
      childStartedAt.set(id, startedAt)
      const agentType = agentTypeForProgramStatusApp(record.app)
      const description =
        programStatusDisplayText(record.title) ?? programStatusDisplayText(record.msg)
      children.push({
        id,
        state,
        startedAt,
        ...(agentType ? { agentType } : {}),
        ...(description ? { description } : {})
      })
    }
    for (const id of childStartedAt.keys()) {
      if (!live.has(id)) {
        childStartedAt.delete(id)
      }
    }
    return children.slice(-AGENT_STATUS_MAX_SUBAGENTS)
  }

  const project = (): ParsedAgentStatusPayload | null => {
    const root = records.root()
    const projection = projectRoot(root)
    if (projection === null) {
      lastRoot = null
      lastKey = null
      return null
    }
    if (projection.state !== lastRoot?.state || projection.outcome !== lastRoot?.outcome) {
      rootStateStartedAt = now()
    }
    lastRoot = projection
    const agentType = agentTypeForProgramStatusApp(root?.app)
    const msg = programStatusDisplayText(root?.msg)
    const subagents = snapshotChildren()
    const payload: ParsedAgentStatusPayload = {
      state: projection.state,
      prompt: '',
      ...(agentType ? { agentType } : {}),
      // Live work names what it is doing or waiting on; a finished turn names its result.
      ...(msg && projection.state !== 'done' ? { toolInput: msg } : {}),
      ...(msg && projection.state === 'done' && projection.sessionBoundary !== true
        ? { lastAssistantMessage: msg }
        : {}),
      ...(projection.sessionBoundary ? { sessionBoundary: true } : {}),
      ...(subagents.length > 0 ? { subagents } : {}),
      mainAgent: {
        state: projection.state,
        ...(projection.outcome ? { outcome: projection.outcome } : {}),
        stateStartedAt: rootStateStartedAt
      }
    }
    // Why a key: redraws re-send identical reports, and only changes are news to the store.
    const key = JSON.stringify(payload)
    if (key === lastKey) {
      return null
    }
    lastKey = key
    return payload
  }

  return {
    process: (data) => {
      const events = scan(data)
      const payloads: { payload: ParsedAgentStatusPayload; offset: number }[] = []
      const rootChanges: ProgramStatusRootChange[] = []
      const facetBefore = lastFacet
      for (const event of events) {
        let changed: boolean
        switch (event.type) {
          case 'query':
            // Answered by the terminal emulator that owns replies for this chunk.
            continue
          case 'report':
            changed = records.apply(event.report)
            break
          case 'prompt-start':
            changed = records.endProgram()
            break
          case 'full-reset':
            changed = records.reset()
            break
        }
        if (!changed) {
          continue
        }
        const root = records.root()
        rootChanges.push({ offset: event.offset, root })
        const facet = root ? programStatusFacetFromRecord(root, now()) : undefined
        // Keep the earlier facet object (and its observedAt) when the report repeats it.
        lastFacet = programStatusFacetsEqual(lastFacet, facet) ? lastFacet : facet
        const payload = project()
        if (payload) {
          payloads.push({ payload, offset: event.offset })
        }
      }
      if (lastFacet === facetBefore) {
        return { payloads, rootChanges }
      }
      return { payloads, rootChanges, facet: lastFacet ?? null }
    }
  }
}
