/**
 * check-recorder.ts: run the REAL recorder function end to end against fakes.
 *
 *   deno run -A scripts/check-recorder.ts
 *
 * `globalThis.fetch` is replaced BEFORE the function is imported. Supabase's
 * REST API (PostgREST) is answered by a small in-memory table store that
 * honours the filters the function uses; Recall, Zernio, YouTube and Gemini are
 * stubs. Nothing real is contacted: any other URL throws.
 *
 * WHAT IT PROVES
 *   a. a request without the secret is refused (401)
 *   b. discovery ingests only bots THIS install sent (metadata.source), and
 *      stores each transcript line with its real time from Recall's words
 *   c. no chosen YouTube channel means nothing publishes, and the row says why
 *   d. the upload to Zernio is unlisted in BOTH places, scheduled (never
 *      publishNow), and moves the row to publishing
 *   e. Zernio "published" stores the YouTube URL
 *   f. the timeline is built from real times (estimated: false)
 *   g. RECLAIM: YouTube 404 keeps the Recall original even though Zernio said
 *      Published; YouTube 200 deletes it. This is the 2026-09-21 incident.
 *   h. a signed recap link opens in `recap`, and a tampered one does not
 */

const SECRET = 'test-recorder-secret'
Deno.env.set('SUPABASE_URL', 'https://stub.supabase.co')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')
Deno.env.set('RECORDER_SECRET', SECRET)
Deno.env.set('RECAP_SIGN_SECRET', 'test-sign-secret')
Deno.env.set('RECALL_API_KEY', 'test-recall')
Deno.env.set('ZERNIO_API_KEY', 'test-zernio')
Deno.env.set('GEMINI_API_KEY', 'test-gemini')
Deno.env.set('RECLAIM_AFTER_HOURS', '0')

/* ------------------------------------------------ in-memory PostgREST -- */

type Row = Record<string, any>
const tables: Record<string, Row[]> = { meetings: [], transcript_entries: [], recorder_settings: [] }
let seq = 0

function matches(row: Row, key: string, expr: string): boolean {
  const v = row[key]
  if (expr === 'is.null') return v === null || v === undefined
  if (expr === 'not.is.null') return !(v === null || v === undefined)
  const [op, ...rest] = expr.split('.')
  const arg = rest.join('.')
  if (op === 'eq') return String(v) === arg
  if (op === 'in') return arg.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(v))
  if (op === 'lt') {
    if (v === null || v === undefined) return false
    return typeof v === 'number' ? v < Number(arg) : String(v) < arg
  }
  throw new Error(`stub: unsupported filter ${key}=${expr}`)
}

async function postgrest(url: URL, method: string, headers: Headers, body: unknown): Promise<Response> {
  const table = url.pathname.split('/').pop()!
  const rows = tables[table]
  if (!rows) throw new Error(`stub: unknown table ${table}`)
  const control = new Set(['select', 'order', 'limit', 'on_conflict', 'columns'])
  const filters = [...url.searchParams.entries()].filter(([k]) => !control.has(k))
  const pick = (r: Row) => filters.every(([k, e]) => matches(r, k, e))
  const single = (headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const answer = (data: Row[]) => {
    if (single) {
      if (data.length === 0) return new Response(JSON.stringify({ code: 'PGRST116', message: 'no rows' }), { status: 406 })
      return new Response(JSON.stringify(data[0]), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  if (method === 'GET') {
    let out = rows.filter(pick)
    const order = url.searchParams.get('order')
    if (order) {
      const [col, dir] = order.split('.')
      out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (dir === 'desc' ? -1 : 1))
    }
    const limit = url.searchParams.get('limit')
    if (limit) out = out.slice(0, Number(limit))
    return answer(out)
  }
  if (method === 'POST') {
    const items = (Array.isArray(body) ? body : [body]) as Row[]
    const conflict = url.searchParams.get('on_conflict')
    const merge = (headers.get('prefer') ?? '').includes('merge-duplicates')
    const saved: Row[] = []
    for (const item of items) {
      const hit = conflict ? rows.find((r) => r[conflict] === item[conflict]) : undefined
      if (hit && merge) { Object.assign(hit, item); saved.push(hit); continue }
      const row: Row = {
        id: item.id ?? (table === 'meetings' ? crypto.randomUUID() : ++seq),
        ...(table === 'meetings' ? { publish_status: 'pending', publish_attempts: 0, timeline_attempts: 0 } : {}),
        ...item,
      }
      rows.push(row); saved.push(row)
    }
    return answer(saved)
  }
  if (method === 'PATCH') {
    const hit = rows.filter(pick)
    for (const r of hit) Object.assign(r, body as Row)
    return answer(hit)
  }
  if (method === 'DELETE') {
    tables[table] = rows.filter((r) => !pick(r))
    return answer([])
  }
  throw new Error(`stub: ${method}`)
}

/* ------------------------------------------------------------ services -- */

const calls = { zernioPosts: [] as Row[], deleteMedia: [] as string[] }
let oembedStatus: Record<string, number> = {}
let zernioStatus = 'published'

const recallBot = (id: string) => ({
  id,
  recordings: [{
    started_at: '2026-09-20T15:00:00Z', completed_at: '2026-09-20T15:40:00Z',
    media_shortcuts: {
      video_mixed: { data: { download_url: `https://s3.stub/${id}.mp4` } },
      transcript: { data: { download_url: `https://s3.stub/${id}-transcript.json` } },
    },
  }],
})
const transcript = [
  { participant: { name: 'Jake' }, words: [{ text: 'Thanks', start_timestamp: { relative: 3.2 } }, { text: 'for joining. Walk me through how leads come in today and where the time goes each week.' }] },
  { participant: { name: 'Kevin' }, words: [{ text: 'Mostly', start_timestamp: { relative: 61.5 } }, { text: 'web forms and Instagram DMs, then I copy them into a spreadsheet by hand every evening.' }] },
  { participant: { name: 'Jake' }, words: [{ text: 'Okay.', start_timestamp: { relative: 128 } }, { text: 'I will send a written plan with scope and price by Friday so you can review it.' }] },
]

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const raw = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.text() : ''
  const body = raw ? JSON.parse(raw) : null
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

  if (url.hostname === 'localhost') return realFetch(input as Request, init)
  if (url.hostname === 'stub.supabase.co') return postgrest(url, method, headers, body)

  if (url.hostname.endsWith('recall.ai')) {
    if (url.pathname === '/api/v1/recording/') {
      return j({ results: [
        { status: { code: 'done' }, bot: { id: 'bot-ours', metadata: { org: 'default', source: 'meeting-recorder' } }, media_shortcuts: { video_mixed: { data: { download_url: 'x' } } } },
        { status: { code: 'done' }, bot: { id: 'bot-someone-else', metadata: {} }, media_shortcuts: { video_mixed: { data: { download_url: 'x' } } } },
      ] })
    }
    const del = url.pathname.match(/^\/api\/v1\/bot\/([^/]+)\/delete_media\/$/)
    if (del) { calls.deleteMedia.push(del[1]); return j({}) }
    const bot = url.pathname.match(/^\/api\/v1\/bot\/([^/]+)\/$/)
    if (bot) return j(recallBot(bot[1]))
  }
  if (url.hostname === 's3.stub') return url.pathname.endsWith('-transcript.json') ? j(transcript) : new Response('mp4')

  if (url.hostname === 'zernio.com') {
    if (method === 'POST' && url.pathname === '/api/v1/posts') { calls.zernioPosts.push(body); return j({ post: { _id: `post-${calls.zernioPosts.length}` } }) }
    if (method === 'GET') return j({ post: { platforms: [{ platform: 'youtube', status: zernioStatus, platformPostUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA' }] } })
  }
  if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed') {
    const status = oembedStatus[url.searchParams.get('url') ?? ''] ?? 404
    return status === 200 ? j({ title: 'x' }) : new Response('Not Found', { status })
  }
  if (url.hostname === 'generativelanguage.googleapis.com') {
    const out = { next_steps: [{ text: 'Send a written plan with scope and price by Friday.', owner: 'Jake' }],
      sections: [{ start: '0:03', title: 'Introductions', summary: 'Jake asks how leads arrive.' },
                 { start: '1:01', title: 'How leads come in', summary: 'Web forms and Instagram DMs, copied by hand.' },
                 { start: '2:08', title: 'Next steps', summary: 'A written plan by Friday.' }] }
    return j({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] })
  }
  throw new Error(`unstubbed fetch: ${method} ${url.href}`)
}) as typeof fetch

/* --------------------------------------------------------------- run -- */

// Both functions call Deno.serve; give each its own port.
const realServe = Deno.serve
const ports = [8601, 8602]
// deno-lint-ignore no-explicit-any
;(Deno as any).serve = (handler: any) => realServe({ port: ports.shift()!, onListen() {} }, handler)
await import('../supabase/functions/recorder/index.ts')
await import('../supabase/functions/recap/index.ts')

const recorder = (action: string, opts: { secret?: string | null; body?: unknown; method?: string } = {}) => {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret !== null) h['x-recorder-secret'] = opts.secret ?? SECRET
  return realFetch(`http://localhost:8601/?action=${action}`, {
    method: opts.method ?? 'POST', headers: h, body: opts.method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))
}

let passed = 0
const failures: string[] = []
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) } else { failures.push(label); console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`) }
}
const meeting = () => tables.meetings.find((m) => m.recall_bot_id === 'bot-ours')!

console.log('\na. auth')
check('no secret is refused', (await recorder('sweep', { secret: null })).status === 401)
check('a wrong secret is refused', (await recorder('sweep', { secret: 'x'.repeat(SECRET.length) })).status === 401)

console.log('\nb-c. discover + ingest, no channel chosen yet')
tables.recorder_settings.push({ org: 'default', youtube_account_id: null, recap_site_url: 'https://recap.example.com' })
let r = await recorder('sweep')
check('sweep ok', r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 300))
check('only our bot was ingested', tables.meetings.length === 1 && Boolean(meeting()), tables.meetings.map((m) => m.recall_bot_id).join(','))
const entries = tables.transcript_entries.filter((e) => e.meeting_id === meeting()?.id)
check('3 transcript lines with real times 3.2 / 61.5 / 128',
  entries.length === 3 && entries.map((e) => e.start_sec).join(',') === '3.2,61.5,128', JSON.stringify(entries.map((e) => e.start_sec)))
check('nothing published without a chosen channel', calls.zernioPosts.length === 0 && meeting().publish_status === 'pending')
check('the row says why', /no YouTube channel chosen/.test(meeting().publish_error ?? ''), meeting().publish_error)

console.log('\nd-f. publish, resolve, timeline')
tables.recorder_settings[0].youtube_account_id = 'yt-account-1'
zernioStatus = 'processing'
r = await recorder('sweep')
const sent = calls.zernioPosts[0] ?? {}
check('one Zernio post', calls.zernioPosts.length === 1, String(calls.zernioPosts.length))
check('unlisted at the top level AND in platformSpecificData',
  sent.visibility === 'unlisted' && sent.platforms?.[0]?.platformSpecificData?.visibility === 'unlisted', JSON.stringify(sent).slice(0, 300))
check('scheduled, never publishNow', typeof sent.scheduledFor === 'string' && !('publishNow' in sent))
check('to the chosen channel, with the Recall video', sent.platforms?.[0]?.accountId === 'yt-account-1' && sent.mediaItems?.[0]?.url === 'https://s3.stub/bot-ours.mp4')
check('row is publishing with the post id', meeting().publish_status === 'publishing' && meeting().publish_post_id === 'post-1', JSON.stringify(meeting()))
check('timeline built with real times', meeting().timeline?.estimated === false && meeting().timeline?.sections?.length === 3, JSON.stringify(meeting().timeline))
check('timeline starts are the real marks 3 / 62 / 128', meeting().timeline?.sections?.map((s: Row) => s.start).join(',') === '3,62,128', JSON.stringify(meeting().timeline?.sections))
zernioStatus = 'published'
r = await recorder('sweep')
check('Zernio "published" stores the YouTube URL', meeting().publish_status === 'published' && meeting().youtube_url === 'https://www.youtube.com/watch?v=AAAAAAAAAAA', JSON.stringify(meeting()))

console.log('\ng. reclaim: only on YouTube\'s own 200')
// The sweep that resolved it already ran reclaim once; YouTube said 404 then.
check('YouTube 404: Recall original KEPT although Zernio said Published', calls.deleteMedia.length === 0 && !meeting().recall_media_deleted_at)
check('and the row says why', /recall copy kept: youtube says the video does not exist/.test(meeting().reclaim_note ?? ''), meeting().reclaim_note)
oembedStatus = { 'https://www.youtube.com/watch?v=AAAAAAAAAAA': 503 }
await recorder('sweep')
check('YouTube 503 (inconclusive): still kept', calls.deleteMedia.length === 0)
oembedStatus = { 'https://www.youtube.com/watch?v=AAAAAAAAAAA': 200 }
await recorder('sweep')
check('YouTube 200: original deleted, once', calls.deleteMedia.length === 1 && calls.deleteMedia[0] === 'bot-ours' && Boolean(meeting().recall_media_deleted_at))

console.log('\nh. signed recap link')
r = await recorder('link', { body: { id: meeting().id } })
check('link minted', r.status === 200 && String(r.body.url).startsWith('https://recap.example.com/?id='), JSON.stringify(r.body))
const link = new URL(r.body.url)
const open = (sig: string) => realFetch(`http://localhost:8602/?id=${link.searchParams.get('id')}&sig=${sig}`).then(async (x) => ({ status: x.status, body: await x.json() }))
const good = await open(link.searchParams.get('sig')!)
check('recap opens with the signed link', good.status === 200 && good.body.youtubeId === 'AAAAAAAAAAA' && good.body.entries.length === 3, JSON.stringify(good.body).slice(0, 200))
check('entries carry their times', good.body.entries.map((e: Row) => e.at).join(',') === '3,62,128')
const bad = await open('0'.repeat(64))
check('a tampered signature is refused', bad.status === 401)

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); Deno.exit(1) }
Deno.exit(0)
