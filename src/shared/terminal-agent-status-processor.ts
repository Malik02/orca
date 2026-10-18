import type { AgentStatus } from './agent-title-core'
import type { ParsedAgentStatusPayload } from './agent-status-types'
import { createAgentStatusOscProcessor, type ProcessedAgentStatusChunk } from './agent-status-osc'
import { programStatusActivity } from './program-status/activity'
import { createProgramStatusProjector } from './program-status/agent-status-projector'
import type { ProgramStatusFacet } from './program-status/facet'

type ProgramStatusSideEffectScan = {
  payloads: ParsedAgentStatusPayload[]
  /** End offset of the last payload in the chunk. */
  lastPayloadOffset: number | null
  /** See ProcessedAgentStatusChunk.programActivity. */
  activity: (AgentStatus | null)[]
  /** See ProcessedAgentStatusChunk.programStatusFacet. */
  facet?: ProgramStatusFacet | null
}

/** Stateful per-PTY OSC 7501 reader for side effects: status payloads, activity and the facet. */
export function createProgramStatusSideEffectScanner(): (
  data: string
) => ProgramStatusSideEffectScan {
  const programStatus = createProgramStatusProjector()
  let lastActivity: AgentStatus | null = null
  return (data) => {
    const { payloads, rootChanges, facet } = programStatus.process(data)
    const activity: (AgentStatus | null)[] = []
    for (const change of rootChanges) {
      const next = programStatusActivity(change.root)
      if (next !== lastActivity) {
        activity.push(next)
        lastActivity = next
      }
    }
    return {
      payloads: payloads.map(({ payload }) => payload),
      lastPayloadOffset: payloads.at(-1)?.offset ?? null,
      activity,
      ...(facet !== undefined ? { facet } : {})
    }
  }
}

/**
 * Every in-band agent status a PTY stream carries, for main's side-effect scan: Orca's OSC 9999
 * payloads (stripped from `cleanData`) and the Program Status Protocol, OSC 7501 (left in place).
 */
export function createTerminalAgentStatusProcessor(): (data: string) => ProcessedAgentStatusChunk {
  const processAgentStatusOsc = createAgentStatusOscProcessor()
  const scanProgramStatus = createProgramStatusSideEffectScanner()
  return (data) => {
    const chunk = processAgentStatusOsc(data)
    const scan = scanProgramStatus(chunk.cleanData)
    if (scan.payloads.length === 0 && scan.activity.length === 0 && scan.facet === undefined) {
      return chunk
    }
    return {
      ...chunk,
      payloads: [...chunk.payloads, ...scan.payloads],
      lastPayloadCleanOffset:
        scan.lastPayloadOffset === null
          ? chunk.lastPayloadCleanOffset
          : Math.max(chunk.lastPayloadCleanOffset ?? 0, scan.lastPayloadOffset),
      ...(scan.payloads.length > 0 ? { programStatusPayloads: new Set(scan.payloads) } : {}),
      ...(scan.activity.length > 0 ? { programActivity: scan.activity } : {}),
      ...(scan.facet !== undefined ? { programStatusFacet: scan.facet } : {})
    }
  }
}
