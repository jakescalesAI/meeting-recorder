# meeting-recorder

Record a video call, put the recording on YouTube (unlisted), and send the
client a recap page with the agreed next steps, the video and a timeline of the
call that jumps the video to each part. Everything on the page downloads.

This is the workflow we run at [Quartzi](https://quartzi.ai) for our own client
calls, published as-is.

```
Recall.ai notetaker joins the call
        │  (Recall calls the webhook when the recording is done)
        ▼
recorder ── transcript, with the real time of every line
        ├──► Zernio ──► YouTube, unlisted
        ├──► Gemini ──► next steps + timeline of the call
        └──► Recall original deleted, ONLY after YouTube confirms the video plays
        ▼
Signed recap link ──► recap page
   next steps  →  YouTube player  →  timeline (click to jump)  →  downloads
```

Built on Supabase: Postgres, two Edge Functions and a cron job. The recap page
is one static HTML file you can host anywhere.

## What it costs to run

| Piece | Price (public list, Sept 2026) |
|---|---|
| [Recall.ai](https://www.recall.ai/pricing) notetaker | $0.50 per hour recorded, billed to the second |
| Transcript | uses the meeting's own captions; Recall's built-in transcription is listed at $0.15/hr if you switch to it |
| Recall storage | 7 days free; this deletes the original once YouTube has it |
| [Zernio](https://zernio.com) | your Zernio plan |
| YouTube | free, unlimited unlisted uploads |
| Gemini | free tier (see the privacy note below) |
| Supabase | free tier is enough to start |

At the list price, recording a 45-minute call costs about **$0.38** in Recall
fees, plus your Zernio plan.

## You need

- A Supabase project
- A Recall.ai API key
- A Zernio account with your **YouTube channel connected**
- That YouTube channel **verified by phone** (youtube.com/verify). Unverified
  channels cannot keep uploads longer than 15 minutes: YouTube accepts the
  upload, then refuses it. We found out the hard way.
- A free Google AI Studio key (Gemini)

> **Privacy:** on Gemini's free tier, Google may use what you send (your call
> transcripts) to improve its products. For client calls, use a paid key.

## Set it up (about 15 minutes)

```bash
git clone https://github.com/jakescalesAI/meeting-recorder
cd meeting-recorder
npx supabase login
npx supabase link --project-ref <project-ref>
```

**1. Database**

```bash
npx supabase db push
```

**2. Secrets.** Copy `.env.example` to `.env`, fill it in, then:

```bash
npx supabase secrets set --env-file .env
```

**3. Functions**

```bash
npx supabase functions deploy recorder --no-verify-jwt
```

```bash
npx supabase functions deploy recap --no-verify-jwt
```

**4. Choose the YouTube channel and your recap site.** In the SQL editor (the
account id is your YouTube account's id in Zernio):

```sql
update recorder_settings
set youtube_account_id = '<zernio-youtube-account-id>',
    brand_name         = 'Your Company',
    accent_color       = '#8c5a3c',
    recap_site_url     = 'https://recap.yourdomain.com'
where org = 'default';
```

Nothing uploads until a channel is chosen. Publishing someone's calls is an
outward action, so it waits for you to say where.

**5. The sweep.** Open `supabase/cron.sql`, replace the two placeholders, and
run it in the SQL editor. It runs every 10 minutes: uploads, checks YouTube,
builds timelines, cleans up Recall.

**6. Recall's webhook** (Recall dashboard → Webhooks) so recordings are picked up
the moment they finish:

```
https://<project-ref>.supabase.co/functions/v1/recorder?action=webhook&secret=<RECORDER_SECRET>
```

**7. The recap page.** Put your recap function URL in `site/config.js` and host
the `site/` folder anywhere (Netlify, Vercel, Cloudflare Pages, S3, nginx).

## Use it

Send the notetaker to a call:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/recorder?action=join" \
  -H "x-recorder-secret: <RECORDER_SECRET>" -H "content-type: application/json" \
  -d '{"meeting_url":"https://meet.google.com/abc-defg-hij","title":"Discovery call"}'
```

After the call, get the recap link to send the client:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/recorder?action=link" \
  -H "x-recorder-secret: <RECORDER_SECRET>" -H "content-type: application/json" \
  -d '{"id":"<meeting id from the join response>"}'
```

See what's in flight:

```bash
curl "https://<project-ref>.supabase.co/functions/v1/recorder?action=status" -H "x-recorder-secret: <RECORDER_SECRET>"
```

Preview the recap page's design with sample data: serve `site/` on localhost
and open `/?sample=1`.

## Safety rules it follows

These came from production incidents, and each one has a test in
`scripts/check-recorder.ts`.

- **The Recall original is deleted only when YouTube itself says the video
  plays.** Zernio's "Published" means YouTube *accepted* the upload, not that it
  kept it. Trusting it once cost us 7 recordings.
- **Uploads are unlisted**, set in both places Zernio reads, and scheduled 30
  seconds out rather than published inline (inline video uploads time out).
- **Only bots this install sent are picked up**, so a Recall workspace you also
  use for something else is never swept in.
- **Recap links are signed.** Only the server can mint one; a changed id or
  signature is refused.
- **Timeline times are real**, taken from Recall's word timestamps. If a
  transcript has none, the page says the times are approximate.

## Test

```bash
deno run -A scripts/check-recorder.ts
```

Runs the real `recorder` and `recap` functions against fakes of every outside
service. No accounts or keys needed.

## License

MIT. See [LICENSE](LICENSE).
