// recap: the data behind the recap page, for a signed link only.
//
//   GET ?id=<meeting>&sig=<hex HMAC-SHA256(id)>
//
// No secret in the browser: the page passes on the id and sig from its own URL,
// and this function checks the signature with RECAP_SIGN_SECRET. A wrong or
// missing signature and an unknown meeting answer the same way, so ids cannot
// be probed.

import { db, json, cors, settingsFor } from '../_shared/db.ts'
import { verify } from '../_shared/sign.ts'
import { youtubeId } from '../_shared/youtube.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'GET') return json({ error: 'GET only' }, 405)
  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  const sig = url.searchParams.get('sig') ?? ''
  if (!(await verify(id, sig))) return json({ error: 'This link is invalid or has expired.' }, 401)

  const { data: m, error } = await db.from('meetings')
    .select('id, org, title, started_at, ended_at, full_text, youtube_url, publish_status, timeline')
    .eq('id', id).maybeSingle()
  if (error || !m) return json({ error: 'This link is invalid or has expired.' }, 401)

  const { data: entries } = await db.from('transcript_entries')
    .select('speaker, text, start_sec').eq('meeting_id', id).order('seq', { ascending: true })
  const s = await settingsFor(m.org)

  return json({
    title: m.title,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    youtubeId: m.publish_status === 'published' ? youtubeId(m.youtube_url) : null,
    processing: m.publish_status !== 'published',
    timeline: m.timeline ?? null,
    entries: (entries ?? []).map((e) => ({
      speaker: e.speaker || 'Speaker',
      text: e.text,
      ...(e.start_sec !== null && e.start_sec !== undefined ? { at: Math.round(Number(e.start_sec)) } : {}),
    })),
    transcript: (entries ?? []).length ? null : m.full_text,
    brand: { name: s.brand_name, logoUrl: s.logo_url, accent: s.accent_color },
  })
})
