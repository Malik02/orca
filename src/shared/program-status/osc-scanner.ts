import {
  PROGRAM_STATUS_MAX_SEQUENCE_BYTES,
  PROGRAM_STATUS_OSC_PREFIX,
  parseProgramStatusBody,
  type ProgramStatusMessage
} from './protocol'
import { ownRetainedString } from '../own-retained-string'

/** Everything in a PTY stream that touches OSC 7501 records, in byte order. `offset` is the index
 *  in the chunk just past the sequence (0 when it ended inside carried bytes). */
type ProgramStatusStreamEvent =
  | (ProgramStatusMessage & { offset: number })
  | { type: 'prompt-start'; offset: number }
  | { type: 'full-reset'; offset: number }

// Why these two: the spec ties record lifetime to a new shell prompt (OSC 133 A) and a full reset (RIS).
const PROMPT_START_MARKER = '\x1b]133;A'
const FULL_RESET_MARKER = '\x1bc'
const MARKERS = [PROGRAM_STATUS_OSC_PREFIX, PROMPT_START_MARKER, FULL_RESET_MARKER] as const
const MAX_BODY_LENGTH = PROGRAM_STATUS_MAX_SEQUENCE_BYTES - PROGRAM_STATUS_OSC_PREFIX.length - 1

/** Longest suffix of `data` that could still grow into a marker. */
function markerPrefixCarry(data: string): string {
  const lastEsc = data.lastIndexOf('\x1b')
  if (lastEsc === -1 || data.length - lastEsc >= PROGRAM_STATUS_OSC_PREFIX.length) {
    return ''
  }
  const suffix = data.slice(lastEsc)
  return MARKERS.some((marker) => marker.length > suffix.length && marker.startsWith(suffix))
    ? suffix
    : ''
}

/** First BEL or ST starting in [from, limit); the bound keeps an unterminated frame's cost fixed. */
function findOscTerminator(
  data: string,
  from: number,
  limit: number = data.length
): { index: number; length: number } | null {
  const end = Math.min(limit, data.length)
  for (let index = from; index < end; index++) {
    const code = data.charCodeAt(index)
    if (code === 0x07) {
      return { index, length: 1 }
    }
    if (code === 0x1b && data.charCodeAt(index + 1) === 0x5c) {
      return { index, length: 2 }
    }
  }
  return null
}

/** Stateful OSC 7501 scanner for one PTY stream. Does not strip anything from the stream. */
export function createProgramStatusOscScanner(): (data: string) => ProgramStatusStreamEvent[] {
  let pending = ''

  return (data) => {
    if (
      pending.length === 0 &&
      !data.includes(PROGRAM_STATUS_OSC_PREFIX) &&
      !data.includes(PROMPT_START_MARKER) &&
      !data.includes(FULL_RESET_MARKER)
    ) {
      pending = markerPrefixCarry(data)
      return []
    }
    const carried = pending.length
    const combined = pending + data
    pending = ''
    const events: ProgramStatusStreamEvent[] = []
    const offsetOf = (end: number): number => Math.max(0, end - carried)
    let cursor = 0
    while (cursor < combined.length) {
      const esc = combined.indexOf('\x1b', cursor)
      if (esc === -1) {
        break
      }
      if (combined.startsWith(FULL_RESET_MARKER, esc)) {
        cursor = esc + FULL_RESET_MARKER.length
        events.push({ type: 'full-reset', offset: offsetOf(cursor) })
        continue
      }
      if (combined.startsWith(PROMPT_START_MARKER, esc)) {
        cursor = esc + PROMPT_START_MARKER.length
        events.push({ type: 'prompt-start', offset: offsetOf(cursor) })
        continue
      }
      if (!combined.startsWith(PROGRAM_STATUS_OSC_PREFIX, esc)) {
        if (combined.length - esc < PROGRAM_STATUS_OSC_PREFIX.length) {
          pending = markerPrefixCarry(combined.slice(esc))
          if (pending.length > 0) {
            break
          }
        }
        cursor = esc + 1
        continue
      }
      const bodyStart = esc + PROGRAM_STATUS_OSC_PREFIX.length
      const terminator = findOscTerminator(combined, bodyStart, bodyStart + MAX_BODY_LENGTH + 1)
      if (terminator === null) {
        if (combined.length - bodyStart <= MAX_BODY_LENGTH) {
          // Own the partial frame so it stops pinning the chunk it was sliced from.
          pending = ownRetainedString(combined.slice(esc))
          break
        }
        // Over the sequence cap: discard whole and resume after the introducer.
        cursor = bodyStart
        continue
      }
      cursor = terminator.index + terminator.length
      const message = parseProgramStatusBody(combined.slice(bodyStart, terminator.index))
      if (message) {
        events.push({ ...message, offset: offsetOf(cursor) })
      }
    }
    return events
  }
}
