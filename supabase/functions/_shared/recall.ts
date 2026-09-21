// Recall.ai: send a bot, read the finished recording, delete the original.
//
// Ported from production (Quartzi, 2026-09). The tolerant field walks are
// deliberate: Recall's docs and its live payloads put the same URLs in
// different places, and guessing wrong once means a recording is fetched,
// found empty and marked failed for a key name.

const REGION = Deno.env.get('RECALL_REGION') ?? 'us-west-2'
const KEY = Deno.env.get('RECALL_API_KEY') ?? ''
const base = () => `https://${REGION}.recall.ai/api/v1`
const auth = () => ({ authorization: `Token ${KEY}`, accept: 'application/json' })

export interface Segment { speaker: string; text: string; startSec: number | null }
export interface Recording {
  videoUrl: string | null
  segments: Segment[]
  startedAt: string | null
  endedAt: string | null
  title: string | null
}

export function firstString(values: unknown[]): string | null {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

/** An artifact's download URL, wherever this API version put it. */
function mediaUrl(artifact: unknown): string | null {
  if (!artifact || typeof artifact !== 'object') return null
  const a = artifact as Record<string, any>
  return firstString([a?.data?.download_url, a.download_url, a?.data?.url, a.url])
}

/**
 * Send the notetaker to a call. Recall's own transcription of the meeting's
 * captions is used (`meeting_captions`), which costs nothing extra.
 */
export async function createBot(opts: { meetingUrl: string; botName: string; org: string }): Promise<{ id: string }> {
  const res = await fetch(`${base()}/bot/`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({
      meeting_url: opts.meetingUrl,
      bot_name: opts.botName,
      // `source` marks bots THIS install sent. Discovery only picks up those, so
      // pointing it at a Recall workspace you also use elsewhere never pulls
      // someone else's recordings in.
      metadata: { org: opts.org, source: BOT_SOURCE },
      recording_config: {
        transcript: { provider: { meeting_captions: {} } },
        video_mixed_mp4: {},
        video_mixed_layout: 'speaker_view',
      },
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`recall create bot ${res.status}: ${text.slice(0, 300)}`)
  return { id: String(JSON.parse(text).id) }
}

/**
 * Transcript JSON -> timed segments. Recall's canonical form is an array of
 * participant paragraphs, each with words[] carrying start_timestamp.relative
 * (seconds into the recording). That first word's time is the line's time.
 */
export function segmentsFrom(t: unknown): Segment[] {
  if (!Array.isArray(t)) return []
  const out: Segment[] = []
  for (const seg of t as any[]) {
    const words: any[] = Array.isArray(seg?.words) ? seg.words : []
    const text = (firstString([seg?.text]) ?? words.map((w) => (typeof w === 'string' ? w : w?.text ?? '')).join(' ')).replace(/\s+/g, ' ').trim()
    if (!text) continue
    const rel = words[0]?.start_timestamp?.relative
    out.push({
      speaker: firstString([seg?.participant?.name, seg?.speaker]) ?? 'Speaker',
      text,
      startSec: typeof rel === 'number' && Number.isFinite(rel) ? rel : null,
    })
  }
  return out
}

/** The finished recording + transcript for a bot. */
export async function fetchRecording(botId: string): Promise<Recording> {
  const res = await fetch(`${base()}/bot/${botId}/`, { headers: auth() })
  if (!res.ok) throw new Error(`recall bot ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const bot = await res.json() as Record<string, any>
  const recs: any[] = Array.isArray(bot.recordings) ? bot.recordings : []
  const rec = recs.find((r) => mediaUrl(r?.media_shortcuts?.video_mixed)) ?? recs[0] ?? null

  let segments: Segment[] = []
  const tUrl = mediaUrl(rec?.media_shortcuts?.transcript)
  if (tUrl) {
    // Pre-signed: it must NOT carry Recall's auth header, S3 rejects both.
    const t = await fetch(tUrl, { headers: { accept: 'application/json' } })
    if (t.ok) segments = segmentsFrom(await t.json().catch(() => null))
  }
  return {
    videoUrl: mediaUrl(rec?.media_shortcuts?.video_mixed),
    segments,
    startedAt: firstString([rec?.started_at, bot.join_at]),
    endedAt: firstString([rec?.completed_at]),
    title: firstString([rec?.media_shortcuts?.meeting_metadata?.data?.title, bot?.meeting_metadata?.title]),
  }
}

export const BOT_SOURCE = 'meeting-recorder'

/** Finished recordings from bots this install sent, that still have media. */
export async function listFinished(limit = 25): Promise<{ botId: string; org: string | null }[]> {
  const res = await fetch(`${base()}/recording/?limit=${limit}`, { headers: auth() })
  if (!res.ok) return []
  const body = await res.json().catch(() => ({})) as Record<string, any>
  const rows: any[] = Array.isArray(body.results) ? body.results : []
  return rows
    .filter((r) => String(r?.status?.code ?? '').toLowerCase() === 'done' && mediaUrl(r?.media_shortcuts?.video_mixed))
    .filter((r) => r?.bot?.metadata?.source === BOT_SOURCE)
    .map((r) => ({ botId: String(r?.bot?.id ?? r?.bot_id ?? ''), org: firstString([r?.bot?.metadata?.org]) }))
    .filter((r) => r.botId)
}

/** Irreversible. Only ever called after YouTube confirms the upload plays. */
export async function deleteMedia(botId: string): Promise<{ deleted: boolean; note: string }> {
  try {
    const res = await fetch(`${base()}/bot/${botId}/delete_media/`, { method: 'POST', headers: auth() })
    if (res.status === 409) return { deleted: true, note: 'already in progress' }
    if (!res.ok) return { deleted: false, note: `delete_media ${res.status}` }
    return { deleted: true, note: 'ok' }
  } catch (e) {
    return { deleted: false, note: String((e as Error).message).slice(0, 160) }
  }
}
