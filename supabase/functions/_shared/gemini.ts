// Gemini, on a free Google AI Studio key.
//
// TIMELINE_MODEL (default gemini-2.5-flash) writes next steps + sections. When
// the free tier's rate limit answers 429, the same request is retried once on
// FALLBACK_MODEL (default gemini-2.5-flash-lite), which has a larger free
// allowance. Production uses the same pair.
//
// PRIVACY: on the free tier Google may use what is sent (call transcripts) to
// improve its products. Use a paid key for client calls.

const KEY = Deno.env.get('GEMINI_API_KEY') ?? ''
export const MODEL = Deno.env.get('TIMELINE_MODEL') ?? 'gemini-2.5-flash'
export const FALLBACK_MODEL = Deno.env.get('FALLBACK_MODEL') ?? 'gemini-2.5-flash-lite'

async function call(model: string, system: string, user: string): Promise<Response> {
  return await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  })
}

/** JSON from the model, and which model produced it. */
export async function askJson(system: string, user: string): Promise<{ json: unknown; model: string }> {
  if (!KEY) throw new Error('GEMINI_API_KEY is not set')
  let model = MODEL
  let res = await call(model, system, user)
  if (res.status === 429 && FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
    model = FALLBACK_MODEL
    res = await call(model, system, user)
  }
  if (!res.ok) throw new Error(`gemini ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(`no text in the ${model} response`)
  return { json: JSON.parse(text), model }
}
