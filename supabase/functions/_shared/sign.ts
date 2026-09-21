// Signed recap links: sig = hex HMAC-SHA256(meeting id) with RECAP_SIGN_SECRET.
// Only the functions hold the secret, so a link cannot be forged or guessed.

const SECRET = Deno.env.get('RECAP_SIGN_SECRET') ?? ''

export async function sign(id: string): Promise<string> {
  if (!SECRET) throw new Error('RECAP_SIGN_SECRET is not set')
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id)))
  return Array.from(mac).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verify(id: string, sig: string): Promise<boolean> {
  if (!SECRET || !id || !sig) return false
  const want = await sign(id)
  const got = sig.toLowerCase()
  if (want.length !== got.length) return false
  let d = 0
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i)
  return d === 0
}

/** The full recap URL for a meeting, or null when no site URL is configured. */
export async function recapUrl(siteUrl: string | null | undefined, id: string): Promise<string | null> {
  const s = String(siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(s)) return null
  return `${s}/?id=${encodeURIComponent(id)}&sig=${await sign(id)}`
}
