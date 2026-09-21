// recorder: the whole pipeline in one function.
//
//   POST ?action=join      { meeting_url, title?, org? }  send the notetaker to a call
//   POST ?action=webhook   (Recall calls this)            ingest + publish as soon as a recording is done
//   POST ?action=sweep     (cron)                         catch up on everything below
//   POST ?action=link      { id }                         the signed recap URL for a meeting
//   GET  ?action=status                                   counts, for a quick look
//
// Every call needs RECORDER_SECRET, as the `x-recorder-secret` header or, for
// Recall's webhook URL (which cannot carry headers), `?secret=`.
//
// The sweep, in order:
//   1. discover   finished recordings from bots this install sent, not yet stored
//   2. ingest     transcript (with real per-line times) into the meeting row
//   3. publish    upload to YouTube through Zernio, unlisted
//   4. resolve    ask Zernio whether YouTube has it yet; store the URL
//   5. timeline   next steps + timed sections with Gemini
//   6. reclaim    delete the Recall original ONLY after YouTube says it plays

import { db, json, cors, ORG_RE, settingsFor } from '../_shared/db.ts'
import { createBot, deleteMedia, fetchRecording, listFinished, type Segment } from '../_shared/recall.ts'
import { publishVideo, postState, youtubeTitle } from '../_shared/zernio.ts'
import { youtubePlays } from '../_shared/youtube.ts'
import { askJson } from '../_shared/gemini.ts'
import { linesWithTimes, normalize, renderForModel, SYSTEM } from '../_shared/timeline.ts'
import { recapUrl } from '../_shared/sign.ts'

const SECRET = Deno.env.get('RECORDER_SECRET') ?? ''
const BOT_NAME = Deno.env.get('BOT_NAME') ?? 'Notetaker'
const MAX_PUBLISH_ATTEMPTS = 5
const MAX_TIMELINE_ATTEMPTS = 3
// Recall keeps a recording free for 7 days. The original is deleted just
// before that, and only once YouTube confirms the upload plays.
const RECLAIM_AFTER_HOURS = Number(Deno.env.get('RECLAIM_AFTER_HOURS') ?? 156)

function authorized(req: Request, url: URL): boolean {
  if (!SECRET) return false
  const got = req.headers.get('x-recorder-secret') ?? url.searchParams.get('secret') ?? ''
  if (got.length !== SECRET.length) return false
  let d = 0
  for (let i = 0; i < got.length; i++) d |= got.charCodeAt(i) ^ SECRET.charCodeAt(i)
  return d === 0
}

const now = () => new Date().toISOString()

/* ── 2. ingest ─────────────────────────────────────────────────────────── */

function plainText(segments: Segment[]): string {
  return segments.map((s) => `${s.speaker}: ${s.text}`).join('\n')
}

/** Store a finished recording's transcript and times. Returns the meeting id. */
async function ingest(botId: string, orgHint: string | null): Promise<{ id: string; lines: number }> {
  const rec = await fetchRecording(botId)
  const { data: existing } = await db.from('meetings').select('id, org, title').eq('recall_bot_id', botId).maybeSingle()
  const org = existing?.org ?? (orgHint && ORG_RE.test(orgHint) ? orgHint : 'default')
  const row = {
    recall_bot_id: botId,
    org,
    title: existing?.title ?? rec.title,
    started_at: rec.startedAt,
    ended_at: rec.endedAt,
    full_text: rec.segments.length ? plainText(rec.segments) : null,
    updated_at: now(),
  }
  const { data: saved, error } = await db.from('meetings').upsert(row, { onConflict: 'recall_bot_id' }).select('id').single()
  if (error || !saved) throw new Error(`save meeting: ${error?.message ?? 'no row'}`)

  if (rec.segments.length) {
    await db.from('transcript_entries').delete().eq('meeting_id', saved.id)
    const entries = rec.segments.map((s, seq) => ({ meeting_id: saved.id, seq, speaker: s.speaker, text: s.text, start_sec: s.startSec }))
    for (let i = 0; i < entries.length; i += 500) {
      const { error: e } = await db.from('transcript_entries').insert(entries.slice(i, i + 500))
      if (e) throw new Error(`save transcript: ${e.message}`)
    }
  }
  return { id: saved.id, lines: rec.segments.length }
}

/* ── 3. publish ────────────────────────────────────────────────────────── */

async function publish(m: { id: string; org: string; recall_bot_id: string; title: string | null; started_at: string | null; publish_attempts: number }) {
  const settings = await settingsFor(m.org)
  if (!settings.youtube_account_id) {
    await db.from('meetings').update({
      publish_error: `no YouTube channel chosen for "${m.org}": set recorder_settings.youtube_account_id to your Zernio YouTube account id`,
      updated_at: now(),
    }).eq('id', m.id)
    return { id: m.id, skipped: 'no channel chosen' }
  }
  try {
    const rec = await fetchRecording(m.recall_bot_id)
    if (!rec.videoUrl) throw new Error('recall has no video for this bot (yet)')
    const title = youtubeTitle(m.title ?? rec.title, m.started_at ?? rec.startedAt)
    const { postId } = await publishVideo({
      accountId: settings.youtube_account_id,
      videoUrl: rec.videoUrl,
      title,
      description: `Recording of ${title}.`,
    })
    await db.from('meetings').update({
      publish_status: 'publishing', publish_post_id: postId, publish_error: null,
      publish_attempts: m.publish_attempts + 1, updated_at: now(),
    }).eq('id', m.id)
    return { id: m.id, publishing: postId }
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 400)
    await db.from('meetings').update({
      publish_status: 'failed', publish_error: msg, publish_attempts: m.publish_attempts + 1, updated_at: now(),
    }).eq('id', m.id)
    return { id: m.id, error: msg }
  }
}

/* ── 4. resolve ────────────────────────────────────────────────────────── */

async function resolve(m: { id: string; publish_post_id: string }) {
  try {
    const s = await postState(m.publish_post_id)
    if (s.state === 'published') {
      await db.from('meetings').update({
        publish_status: 'published', youtube_url: s.url, published_at: now(), publish_error: null, updated_at: now(),
      }).eq('id', m.id)
      return { id: m.id, published: s.url }
    }
    if (s.state === 'failed') {
      // The upload itself failed, so a retry cannot duplicate anything.
      await db.from('meetings').update({
        publish_status: 'failed', publish_post_id: null, publish_error: s.error, updated_at: now(),
      }).eq('id', m.id)
      return { id: m.id, failed: s.error }
    }
    return { id: m.id, waiting: s.note }
  } catch (e) {
    return { id: m.id, error: String((e as Error).message).slice(0, 200) }
  }
}

/* ── 5. timeline ───────────────────────────────────────────────────────── */

async function buildTimeline(m: { id: string; full_text: string | null; started_at: string | null; ended_at: string | null; timeline_attempts: number }) {
  const text = String(m.full_text ?? '').trim()
  if (text.length < 200) return { id: m.id, skipped: 'transcript too short' }
  try {
    const { data: entries } = await db.from('transcript_entries')
      .select('speaker, text, start_sec').eq('meeting_id', m.id).order('seq', { ascending: true })
    const a = Date.parse(String(m.started_at ?? '')), b = Date.parse(String(m.ended_at ?? ''))
    const span = Number.isFinite(a) && Number.isFinite(b) && b > a ? (b - a) / 1000 : 0
    const { lines, estimated } = linesWithTimes(text, entries ?? [], span)
    if (!lines.length) return { id: m.id, skipped: 'no lines' }
    const duration = span || lines[lines.length - 1]!.t
    const { text: forModel, markers } = renderForModel(lines)
    const { json: raw, model } = await askJson(SYSTEM, 'Transcript:\n\n' + forModel)
    const timeline = normalize(raw, markers, duration, estimated)
    if (!timeline.sections.length && !timeline.nextSteps.length) throw new Error('model returned nothing usable')
    await db.from('meetings').update({
      timeline: { ...timeline, model }, timeline_at: now(), timeline_error: null,
      timeline_attempts: m.timeline_attempts + 1, updated_at: now(),
    }).eq('id', m.id)
    return { id: m.id, nextSteps: timeline.nextSteps.length, sections: timeline.sections.length, estimated, model }
  } catch (e) {
    const msg = String((e as Error).message).slice(0, 300)
    await db.from('meetings').update({ timeline_error: msg, timeline_attempts: m.timeline_attempts + 1, updated_at: now() }).eq('id', m.id)
    return { id: m.id, error: msg }
  }
}

/* ── 6. reclaim ────────────────────────────────────────────────────────── */

/**
 * Delete Recall's copy once it is about to start costing money, and ONLY when
 * YouTube itself says the video plays. Zernio's "Published" is not enough: on
 * 2026-09-21 YouTube refused every upload over 15 minutes to an unverified
 * channel after accepting it, and a sweep that trusted "Published" destroyed 7
 * originals. A refused video keeps its original and says why; re-publishing
 * is left to a person, because the same cause would refuse every retry.
 */
async function reclaim() {
  const cutoff = new Date(Date.now() - RECLAIM_AFTER_HOURS * 3600_000).toISOString()
  const { data: rows } = await db.from('meetings')
    .select('id, recall_bot_id, youtube_url')
    .eq('publish_status', 'published').is('recall_media_deleted_at', null)
    .not('recall_bot_id', 'is', null).lt('ended_at', cutoff).limit(25)
  const out = { checked: 0, deleted: 0, kept: 0 }
  for (const r of rows ?? []) {
    out.checked += 1
    const check = r.youtube_url ? await youtubePlays(r.youtube_url) : { plays: false, note: 'no YouTube URL stored' }
    if (!check.plays) {
      await db.from('meetings').update({ reclaim_note: `recall copy kept: ${check.note}`, updated_at: now() }).eq('id', r.id)
      out.kept += 1
      continue
    }
    const del = await deleteMedia(r.recall_bot_id)
    if (!del.deleted) {
      await db.from('meetings').update({ reclaim_note: `delete failed, will retry: ${del.note}`, updated_at: now() }).eq('id', r.id)
      out.kept += 1
      continue
    }
    await db.from('meetings').update({ recall_media_deleted_at: now(), reclaim_note: null, updated_at: now() }).eq('id', r.id)
    out.deleted += 1
  }
  return out
}

/* ── the sweep ─────────────────────────────────────────────────────────── */

async function sweep() {
  const result: Record<string, unknown> = {}

  // 1-2. discover + ingest
  const { data: known } = await db.from('meetings').select('recall_bot_id, full_text')
  const have = new Map((known ?? []).map((k) => [k.recall_bot_id, Boolean(k.full_text)]))
  const ingested = []
  for (const f of await listFinished()) {
    if (have.get(f.botId)) continue
    try { ingested.push({ bot: f.botId, ...(await ingest(f.botId, f.org)) }) }
    catch (e) { ingested.push({ bot: f.botId, error: String((e as Error).message).slice(0, 200) }) }
  }
  result.ingested = ingested

  // 3. publish
  const { data: toPublish } = await db.from('meetings')
    .select('id, org, recall_bot_id, title, started_at, publish_attempts')
    .in('publish_status', ['pending', 'failed']).is('publish_post_id', null)
    .not('recall_bot_id', 'is', null).not('full_text', 'is', null)
    .is('recall_media_deleted_at', null)
    .lt('publish_attempts', MAX_PUBLISH_ATTEMPTS).limit(5)
  result.published = await Promise.all((toPublish ?? []).map(publish))

  // 4. resolve
  const { data: inFlight } = await db.from('meetings')
    .select('id, publish_post_id').eq('publish_status', 'publishing').not('publish_post_id', 'is', null).limit(25)
  result.resolved = await Promise.all((inFlight ?? []).map(resolve))

  // 5. timelines, a few per run (free-tier rate limits)
  const { data: needTimeline } = await db.from('meetings')
    .select('id, full_text, started_at, ended_at, timeline_attempts')
    .is('timeline_at', null).not('full_text', 'is', null)
    .lt('timeline_attempts', MAX_TIMELINE_ATTEMPTS).order('started_at', { ascending: false }).limit(3)
  const timelines = []
  for (const m of needTimeline ?? []) timelines.push(await buildTimeline(m))
  result.timelines = timelines

  // 6. reclaim
  result.reclaim = await reclaim()
  return result
}

/* ── handler ───────────────────────────────────────────────────────────── */

function botIdFrom(body: Record<string, any>): string | null {
  const d = body?.data ?? {}
  const id = d?.bot?.id ?? d?.bot_id ?? body?.bot_id ?? null
  return typeof id === 'string' && id ? id : null
}
function isDone(body: Record<string, any>): boolean {
  const event = String(body?.event ?? '')
  const code = String(body?.data?.data?.code ?? body?.data?.status?.code ?? '').toLowerCase()
  return event === 'recording.done' || event === 'bot.done' || code === 'done'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)
  if (!authorized(req, url)) return json({ error: 'unauthorized' }, 401)
  const action = url.searchParams.get('action') ?? ''

  try {
    if (action === 'status' && req.method === 'GET') {
      const { data } = await db.from('meetings').select('publish_status, timeline_at, recall_media_deleted_at')
      const rows = data ?? []
      const by = (s: string) => rows.filter((r) => r.publish_status === s).length
      return json({
        meetings: rows.length,
        pending: by('pending'), publishing: by('publishing'), published: by('published'), failed: by('failed'),
        withTimeline: rows.filter((r) => r.timeline_at).length,
        recallCopiesDeleted: rows.filter((r) => r.recall_media_deleted_at).length,
      })
    }
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
    const body = await req.json().catch(() => ({})) as Record<string, any>

    if (action === 'join') {
      const meetingUrl = String(body.meeting_url ?? '').trim()
      if (!/^https:\/\//.test(meetingUrl)) return json({ error: 'meeting_url (https) is required' }, 400)
      const org = ORG_RE.test(String(body.org ?? '')) ? String(body.org) : 'default'
      const bot = await createBot({ meetingUrl, botName: String(body.bot_name ?? BOT_NAME), org })
      const { data, error } = await db.from('meetings').insert({
        org, recall_bot_id: bot.id, meeting_url: meetingUrl, title: String(body.title ?? '').trim() || null,
      }).select('id').single()
      if (error) throw new Error(error.message)
      return json({ ok: true, meetingId: data.id, botId: bot.id })
    }

    if (action === 'webhook') {
      // Acknowledge fast; Recall retries non-2xx. Only "done" does any work.
      const botId = botIdFrom(body)
      if (!botId || !isDone(body)) return json({ ok: true, ignored: body?.event ?? 'no bot' })
      const { data: row } = await db.from('meetings').select('org').eq('recall_bot_id', botId).maybeSingle()
      const got = await ingest(botId, row?.org ?? body?.data?.bot?.metadata?.org ?? null)
      // Start the upload now rather than waiting for the next sweep. The sweep
      // still catches it if this fails.
      const { data: m } = await db.from('meetings')
        .select('id, org, recall_bot_id, title, started_at, publish_attempts, publish_status, publish_post_id')
        .eq('id', got.id).single()
      const upload = m && m.publish_status === 'pending' && !m.publish_post_id ? await publish(m) : null
      return json({ ok: true, ...got, upload })
    }

    if (action === 'sweep') return json({ ok: true, ...(await sweep()), at: now() })

    if (action === 'link') {
      const id = String(body.id ?? '')
      const { data: m } = await db.from('meetings').select('id, org').eq('id', id).maybeSingle()
      if (!m) return json({ error: 'meeting not found' }, 404)
      const link = await recapUrl((await settingsFor(m.org)).recap_site_url, m.id)
      if (!link) return json({ error: 'set recorder_settings.recap_site_url first' }, 400)
      return json({ ok: true, url: link })
    }

    return json({ error: 'unknown action' }, 400)
  } catch (e) {
    console.error('[recorder]', e)
    return json({ ok: false, error: String((e as Error).message).slice(0, 300) }, 500)
  }
})

export { reclaim, sweep }
