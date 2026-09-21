/*
 * Timeline rules: next steps + the call split into timed sections. Pure, so a
 * check can drive them. Ported from production (Quartzi, 2026-09-19).
 *
 * Owner's brief for the recap page: "next steps at the top, compact and simple
 * (downloadable), not overcomplicated ai slop ... below the video a full
 * timeline analysis of the meeting (also downloadable)."
 *
 * WHERE THE TIMES COME FROM. Recall's transcript words carry their own
 * timestamps, stored per line in transcript_entries.start_sec, so times are
 * real. Only when a transcript has no timed lines is each line placed by how
 * far through the transcript it sits; that result is marked `estimated` and the
 * page says "approx." rather than presenting a guess as a measurement.
 *
 * WHAT THE MODEL MAY RETURN is checked here, not trusted: section starts must
 * be one of the markers it was shown, next steps are capped at six short lines,
 * and anything empty is dropped.
 */

export interface Line { t: number; speaker: string; text: string }
export interface NextStep { text: string; owner: string }
export interface Section { start: number; end: number; title: string; summary: string }
export interface Timeline {
  version: 1
  estimated: boolean
  durationSec: number
  nextSteps: NextStep[]
  sections: Section[]
}

export const MAX_NEXT_STEPS = 6
export const MAX_SECTIONS = 14

export function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return h ? `${h}:${mm}:${String(r).padStart(2, '0')}` : `${mm}:${String(r).padStart(2, '0')}`
}

export function parseTime(v: unknown): number | null {
  const m = String(v ?? '').trim().replace(/^\[|\]$/g, '').match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/)
  if (!m) return null
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3])
}

/** Transcript lines with a time each: real when entries carry one, else placed by position. */
export function linesWithTimes(
  fullText: string,
  entries: { speaker?: string | null; text?: string | null; start_sec?: number | string | null }[],
  durationSec: number,
): { lines: Line[]; estimated: boolean } {
  const timed = entries.filter((e) => e.text && e.start_sec !== null && e.start_sec !== undefined && Number.isFinite(Number(e.start_sec)))
  if (timed.length > 0) {
    return {
      estimated: false,
      lines: timed.map((e) => ({ t: Math.max(0, Number(e.start_sec)), speaker: String(e.speaker || 'Speaker'), text: String(e.text).trim() })),
    }
  }
  const raw = String(fullText ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const total = raw.reduce((n, l) => n + l.length, 0) || 1
  let seen = 0
  const lines = raw.map((l) => {
    const at = (seen / total) * Math.max(0, durationSec)
    seen += l.length
    const m = l.match(/^([^:]{1,60}):\s*(.*)$/)
    return { t: at, speaker: m ? m[1]!.trim() : 'Speaker', text: (m ? m[2]! : l).trim() }
  })
  return { estimated: true, lines }
}

/** What the model reads: one line per turn, each opened by the marker it must cite. */
export function renderForModel(lines: Line[], maxChars = 110_000): { text: string; markers: Set<number> } {
  const markers = new Set<number>()
  const out: string[] = []
  let size = 0
  for (const l of lines) {
    const row = `[${fmt(l.t)}] ${l.speaker}: ${l.text}`
    if (size + row.length > maxChars) break
    out.push(row)
    markers.add(Math.round(l.t))
    size += row.length + 1
  }
  return { text: out.join('\n'), markers }
}

const clip = (s: unknown, n: number) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim()
  return v.length > n ? v.slice(0, n - 1).trimEnd() + '…' : v
}

/** The model's JSON, reduced to what the page may show. */
export function normalize(raw: unknown, markers: Set<number>, durationSec: number, estimated: boolean): Timeline {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const nextSteps = (Array.isArray(o.next_steps) ? o.next_steps : [])
    .map((s: any) => ({ text: clip(s?.text, 160), owner: clip(s?.owner, 40) }))
    .filter((s) => s.text)
    .slice(0, MAX_NEXT_STEPS)

  // Only starts the model was actually shown; nearest marker when it drifts by a few seconds.
  const known = [...markers].sort((a, b) => a - b)
  const snap = (sec: number) => {
    if (markers.has(sec)) return sec
    let best: number | null = null
    for (const k of known) if (best === null || Math.abs(k - sec) < Math.abs(best - sec)) best = k
    return best !== null && Math.abs(best - sec) <= 20 ? best : null
  }
  const starts = new Set<number>()
  const sections = (Array.isArray(o.sections) ? o.sections : [])
    .map((s: any) => {
      const p = parseTime(s?.start)
      const start = p === null ? null : snap(p)
      return { start, title: clip(s?.title, 70), summary: clip(s?.summary, 300) }
    })
    .filter((s): s is { start: number; title: string; summary: string } => s.start !== null && Boolean(s.title))
    .sort((a, b) => a.start - b.start)
    .filter((s) => (starts.has(s.start) ? false : (starts.add(s.start), true)))
    .slice(0, MAX_SECTIONS)
    .map((s, i, all) => ({ ...s, end: i + 1 < all.length ? all[i + 1]!.start : Math.round(durationSec) }))

  return { version: 1, estimated, durationSec: Math.round(durationSec), nextSteps, sections }
}

export const SYSTEM = [
  'You write the follow-up page a client reads after a business call.',
  'Plain, short sentences. Say what was said or agreed. No praise, no adjectives like "great", "productive" or "insightful", no filler, no emojis.',
  '',
  'next_steps: at most 6. Only things actually agreed or promised on the call. Each is one short sentence starting with a verb.',
  'owner is the first name of the person responsible, or the company name. Use "Both" when shared. Leave out anything nobody committed to.',
  '',
  'sections: split the whole call, in order, into 4 to 12 parts. Each part:',
  '- start: copy one [m:ss] marker from the transcript EXACTLY, without the brackets. It is where that part begins.',
  '- title: at most 8 words naming what was covered.',
  '- summary: one or two sentences of the facts, numbers and decisions from that part.',
  'Call opening chat "Introductions". Do not invent anything that is not in the transcript.',
  '',
  'Return ONLY JSON: {"next_steps":[{"text":"","owner":""}],"sections":[{"start":"","title":"","summary":""}]}',
].join('\n')
