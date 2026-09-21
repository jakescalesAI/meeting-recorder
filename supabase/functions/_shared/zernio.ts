// Zernio: publish the recording to the connected YouTube channel, unlisted.
//
// Same request shape Quartzi's production path sends (sfp-comms,
// social_create_post), called directly.
//
// Three things learned the hard way, all kept here:
//  - A video is NEVER published with publishNow. Zernio would do the whole
//    YouTube ingest inside the HTTP request and the gateway gives up (504). It
//    goes out as a post scheduled 30 seconds ahead instead.
//  - Visibility is set both inside platformSpecificData and at the top level.
//    A post created with only one of them read back as "public".
//  - "Published" from Zernio means YouTube ACCEPTED the upload, not that it
//    kept it. Never delete anything on that word; see youtube.ts.

const KEY = Deno.env.get('ZERNIO_API_KEY') ?? ''
const BASE = 'https://zernio.com/api/v1'

export const VISIBILITY = 'unlisted'

async function zernio(path: string, init?: RequestInit): Promise<Record<string, any>> {
  if (!KEY) throw new Error('ZERNIO_API_KEY is not set')
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`zernio ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text || '{}')
}

/** `Client call — 21 Sep 2026`, trimmed to YouTube's 100 characters. */
export function youtubeTitle(name: string | null, startedAt: string | null): string {
  const when = startedAt
    ? new Date(startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
  const suffix = when ? ` — ${when}` : ''
  const base = (name ?? '').trim() || 'Meeting recording'
  return `${base.slice(0, 100 - suffix.length)}${suffix}`
}

/** Hand the video to Zernio. Returns the post id; the YouTube URL comes later. */
export async function publishVideo(opts: {
  accountId: string
  videoUrl: string
  title: string
  description: string
}): Promise<{ postId: string }> {
  const data = await zernio('/posts', {
    method: 'POST',
    headers: { 'x-request-id': crypto.randomUUID() },
    body: JSON.stringify({
      content: opts.description,
      title: opts.title,
      visibility: VISIBILITY,
      platforms: [{
        platform: 'youtube',
        accountId: opts.accountId,
        platformSpecificData: { visibility: VISIBILITY, title: opts.title },
      }],
      mediaItems: [{ type: 'video', url: opts.videoUrl, mimeType: 'video/mp4' }],
      scheduledFor: new Date(Date.now() + 30_000).toISOString(),
      timezone: 'UTC',
    }),
  })
  const post = (data.post ?? data.existingPost ?? data) as Record<string, any>
  const postId = String(post._id ?? post.id ?? '')
  if (!postId) throw new Error('zernio accepted the post but returned no id')
  return { postId }
}

export type PostState =
  | { state: 'published'; url: string }
  | { state: 'failed'; error: string }
  | { state: 'waiting'; note: string }

/** Where a post stands on YouTube, from Zernio's side. */
export async function postState(postId: string): Promise<PostState> {
  const got = await zernio(`/posts/${encodeURIComponent(postId)}`)
  const post = (got.post ?? got) as Record<string, any>
  const targets: any[] = Array.isArray(post.platforms) ? post.platforms : []
  const yt = targets.find((p) => String(p?.platform ?? '').toLowerCase() === 'youtube') ?? targets[0]
  const status = String(yt?.status ?? post.status ?? '').toLowerCase()
  const url = [yt?.platformPostUrl, yt?.url].find((u) => typeof u === 'string' && u) as string | undefined
  if (status === 'published' && url) return { state: 'published', url }
  if (['failed', 'cancelled', 'canceled'].includes(status)) {
    return { state: 'failed', error: String(yt?.errorMessage ?? yt?.error ?? 'zernio reports failed').slice(0, 300) }
  }
  return { state: 'waiting', note: status || 'unknown' }
}
