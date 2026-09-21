// Does YouTube itself say this video plays?
//
// This is the ONLY check allowed to authorise deleting the Recall original.
//
// Why it exists (production, 2026-09-21): every upload longer than 15 minutes
// to an unverified YouTube channel was accepted, reported "Published" by the
// upload service, and then refused by YouTube ("Video unavailable"). A sweep
// that trusted "Published" deleted 7 originals. Uploads are unlisted, and
// YouTube's public oEmbed endpoint answers 200 for an unlisted video that
// plays, so the strong check is always available.
//
// Measured codes: a playing video answers 200; a refused or removed one 404; a
// made-up id 400. Anything else (5xx, network) is inconclusive, which must
// never authorise a delete.

export async function youtubePlays(videoUrl: string): Promise<{ plays: boolean; note: string }> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { headers: { accept: 'application/json' } },
    )
    if (res.ok) return { plays: true, note: 'youtube oembed 200' }
    if (res.status === 400 || res.status === 404) return { plays: false, note: `youtube says the video does not exist (${res.status})` }
    if (res.status === 401 || res.status === 403) return { plays: false, note: `private or restricted (${res.status})` }
    return { plays: false, note: `youtube oembed ${res.status} (inconclusive)` }
  } catch (e) {
    return { plays: false, note: `${String((e as Error).message).slice(0, 120)} (inconclusive)` }
  }
}

/** The 11-character id from any common YouTube URL form. */
export function youtubeId(url: string | null | undefined): string | null {
  const m = String(url ?? '').match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}
