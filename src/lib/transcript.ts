import type { TranscriptSegment } from '../types'

function parseTime(value: string) {
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':').map(Number)
  if (parts.some((part) => Number.isNaN(part))) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

function segmentText(lines: string[]) {
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  const voiceTag = text.match(/^<v\s+([^>]+)>\s*(.*)$/i)
  if (voiceTag) return { speaker: voiceTag[1].trim(), text: voiceTag[2].trim() }
  const angleTag = text.match(/^<([^>]+)>\s*(.*)$/)
  if (angleTag) return { speaker: angleTag[1].trim(), text: angleTag[2].trim() }
  const speakerLine = text.match(/^([^:：]{1,60})\s*[:：]\s*(.+)$/)
  if (speakerLine && !/^\d{1,2}:\d{2}/.test(speakerLine[1])) return { speaker: speakerLine[1].trim(), text: speakerLine[2].trim() }
  return { text }
}

function makeSegment(index: number, start: number, end: number, lines: string[]): TranscriptSegment | null {
  const parsed = segmentText(lines.filter((line) => line.trim()))
  if (!parsed.text) return null
  const text = parsed.text.replace(/<\/?v(?:\s+[^>]+)?>/gi, '').trim()
  if (!text) return null
  return { id: `imported-${index + 1}`, start, end: end || start, speaker: parsed.speaker, text, originalText: text }
}

/** Parse common Teams WebVTT/SRT exports and simple timestamped text. */
export function parseTeamsTranscript(source: string): TranscriptSegment[] {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')
  const segments: TranscriptSegment[] = []
  const cuePattern = /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/
  const timestampOnly = /^(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\s*$/

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const cue = line.match(cuePattern)
    if (cue) {
      const payload: string[] = []
      index += 1
      while (index < lines.length && lines[index].trim() && !cuePattern.test(lines[index].trim())) {
        payload.push(lines[index].trim())
        index += 1
      }
      const segment = makeSegment(segments.length, parseTime(cue[1]), parseTime(cue[2]), payload)
      if (segment) segments.push(segment)
      index -= 1
      continue
    }
    const simpleTime = line.match(timestampOnly)
    if (simpleTime) {
      const payload: string[] = []
      index += 1
      while (index < lines.length && lines[index].trim()) {
        payload.push(lines[index].trim())
        index += 1
      }
      const segment = makeSegment(segments.length, parseTime(simpleTime[1]), parseTime(simpleTime[1]), payload)
      if (segment) segments.push(segment)
      index -= 1
    }
  }

  if (segments.length) return segments

  const plainLines = lines.filter((line) => line.trim() && !/^WEBVTT|^NOTE|^\d+$/.test(line.trim()))
  return plainLines.map((line, index) => makeSegment(index, 0, 0, [line])).filter((segment): segment is TranscriptSegment => Boolean(segment))
}
