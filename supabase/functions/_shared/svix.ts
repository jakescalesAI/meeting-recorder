/**
 * Verify a webhook from Recall's dashboard (Svix-signed).
 *
 * Recall's dashboard webhooks cannot carry a custom header, so they are
 * signed instead. Ported from Quartzi production (2026-09-21).
 *
 * The scheme, from Recall's docs ("Verifying webhooks ... from Recall.ai"):
 *   headers  webhook-id, webhook-timestamp, webhook-signature (svix-* on older
 *            deliveries)
 *   signed   `${id}.${timestamp}.${rawBody}`
 *   key      base64 after the `whsec_` prefix of the endpoint's signing secret
 *   value    `v1,<base64 HMAC-SHA256>`, space-separated when a rotated secret
 *            is still valid, so ANY v1 match passes
 *
 * A timestamp more than 5 minutes from now is refused, so a captured delivery
 * cannot be replayed later.
 */

const TOLERANCE_SEC = 5 * 60

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

export function hasSvixHeaders(h: Headers): boolean {
  return Boolean((h.get('webhook-id') ?? h.get('svix-id')) && (h.get('webhook-signature') ?? h.get('svix-signature')))
}

export async function verifySvix(
  raw: string,
  h: Headers,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean; reason: string }> {
  if (!secret.startsWith('whsec_')) return { ok: false, reason: 'signing secret is not a whsec_ value' }
  const id = h.get('webhook-id') ?? h.get('svix-id') ?? ''
  const ts = h.get('webhook-timestamp') ?? h.get('svix-timestamp') ?? ''
  const sigs = h.get('webhook-signature') ?? h.get('svix-signature') ?? ''
  if (!id || !ts || !sigs) return { ok: false, reason: 'missing signature headers' }
  const t = Number(ts)
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > TOLERANCE_SEC) return { ok: false, reason: 'timestamp outside 5 minutes' }

  let keyBytes: Uint8Array
  try { keyBytes = b64ToBytes(secret.slice('whsec_'.length)) } catch { return { ok: false, reason: 'signing secret is not base64' } }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`)))

  for (const part of sigs.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    let got: Uint8Array
    try { got = b64ToBytes(sig) } catch { continue }
    if (sameBytes(expected, got)) return { ok: true, reason: 'ok' }
  }
  return { ok: false, reason: 'no matching signature' }
}
