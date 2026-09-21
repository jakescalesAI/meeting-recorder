import { createClient } from 'jsr:@supabase/supabase-js@2.57.4'

export const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? 'http://localhost',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'missing',
  { auth: { persistSession: false } },
)

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-recorder-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

export const ORG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

export interface Settings {
  org: string
  youtube_account_id: string | null
  brand_name: string | null
  logo_url: string | null
  accent_color: string | null
  recap_site_url: string | null
}

/** The org's settings, falling back to the 'default' row field by field. */
export async function settingsFor(org: string): Promise<Settings> {
  const { data } = await db.from('recorder_settings').select('*').in('org', [org, 'default'])
  const own = (data ?? []).find((r) => r.org === org) ?? {}
  const def = (data ?? []).find((r) => r.org === 'default') ?? {}
  const pick = (k: keyof Settings) => (own as any)[k] ?? (def as any)[k] ?? null
  return {
    org,
    // The channel is NOT inherited from 'default' for another org: publishing a
    // brand's calls to someone else's channel must never happen by fallback.
    youtube_account_id: org === 'default' ? pick('youtube_account_id') : ((own as any).youtube_account_id ?? null),
    brand_name: pick('brand_name'),
    logo_url: pick('logo_url'),
    accent_color: pick('accent_color'),
    recap_site_url: pick('recap_site_url'),
  }
}
