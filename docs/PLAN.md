# Extraction plan

This repository is being carved out of a production system: Quartzi's meeting
pipeline, which lives today in a private monorepo (SFPAdmin) and a small static
site (quartzi-meetings). This document says what moves, what has to change on
the way out, and in what order. Written 2026-09-21.

## What the production system does

1. **Ingest.** A Recall.ai bot joins the call. When the recording is ready,
   Recall calls a webhook; the transcript is stored against the meeting.
2. **Publish.** The video is uploaded to the owner's YouTube channel as
   **unlisted**. Today that upload goes through Zernio, a social-posting
   service, not the YouTube API directly.
3. **Summarize.** An LLM (Gemini) writes the agreed next steps and a timed
   breakdown of the call (the "timeline").
4. **Share.** A signed link, `?id=<meeting>&sig=<HMAC-SHA256(id)>`, opens a recap
   page: next steps, then the YouTube player, then the timeline, which seeks the
   video on click. Each part is downloadable.
5. **Reclaim.** About a week later, when Recall's free storage runs out, the
   original is deleted from Recall, but **only after YouTube itself confirms the
   video plays**.

## Source map

| Production file | Lines | Becomes | Notes |
|---|---|---|---|
| `supabase/functions/sfp-recall-webhook/index.ts` | ~1,000 | `supabase/functions/recorder/` | Webhook ingest, hourly sweep, reclaim |
| `supabase/functions/sfp-recall-webhook/publish.ts` | ~700 | `supabase/functions/recorder/publish.ts` | Recall fetch, YouTube publish, verification |
| `supabase/functions/sfp-meeting-timeline/{index,rules}.ts` | 250 | `supabase/functions/timeline/` | Next steps + timed sections |
| `supabase/functions/summarize-transcript/index.ts` | 132 | merged into `timeline/` | One summarizer, not two |
| `supabase/functions/meeting-share/index.ts` | 175 | `supabase/functions/recap/` | Signed read for the recap page |
| `quartzi-meetings/site/share/` | – | `site/share/` | Static recap page, rebranded neutral |
| migrations `003`, `005`, `007`, `008`, `025` | – | `supabase/migrations/0001_init.sql` | Squashed into one clean schema |

Guards that come with it: `check-recall-reclaim.ts` (safe delete),
`check-meeting-timeline.mjs`, `check-recall-import.mjs`.

## What has to change on the way out

1. **Settings.** Production reads per-workspace settings (chosen YouTube
   channel, cron secret) from a generic CRM records table. The open version gets
   its own small `recorder_settings` table and environment variables.
2. **Tenancy.** Production is multi-workspace (an `org` column on everything).
   Keep the column so one install can serve several brands, with a default of
   `default`, so a single user never has to think about it.
3. **YouTube upload: Zernio, as production does** (decided 2026-09-21). The
   repo shows the workflow Quartzi actually runs, so publishing goes through
   Zernio's API to the owner's connected YouTube channel, unlisted. Zernio is
   called directly from the recorder function instead of through Quartzi's
   internal comms function. `publishToYouTube` / `verifyPublished` stay the
   boundary, so a YouTube-direct adapter can be added later without touching
   the rest.
4. **Summarizer: Gemini free tier, as production does** (decided 2026-09-21).
   `gemini-2.5-flash-lite` for the summary and `gemini-2.5-flash` for next steps
   and the timeline, on a free Google AI Studio key. One function wraps the
   call, so the model is an environment variable. **Privacy note for the
   README:** on the free tier Google may use submitted content (call
   transcripts) to improve its products; use a paid key for client calls.
5. **Branding.** Strip Quartzi's name, mark and colours; the recap page takes a
   brand name, logo URL and accent colour from settings.
6. **Secrets.** Nothing is copied from production config. Every key is named in
   `.env.example` and read from the environment.

## Rules that must survive the extraction

These are production incidents, not preferences. Each one has a guard.

- **Delete the Recall original only on YouTube's own 200.** On 2026-09-21, 7
  recordings were lost: YouTube refused every upload over 15 minutes (the
  channel was unverified), the upload service still said "Published", and the
  sweep deleted the originals on that word. Uploads are unlisted, so YouTube's
  public oEmbed endpoint can confirm them. Nothing else authorizes a delete.
- **A refused upload is not retried automatically.** The same cause would
  refuse every retry; retrying is an owner decision.
- **Unlisted by default**, and visibility can be changed after upload without
  re-uploading.
- **Recap links are signed** (HMAC-SHA256 of the meeting id). Only the server
  holds the secret; a link cannot be forged or enumerated.
- **Times without a timestamp are marked estimated.** Recall's caption
  transcript has no per-segment times today, so the timeline says so rather
  than inventing precision.

## Milestones

| | What | Status (2026-09-21) |
|---|---|---|
| **M0** | Skeleton and plan | Done |
| **M1** | Schema + Recall ingest (with real per-line times) | Built; tested against fakes |
| **M2** | Zernio publish + safe reclaim | Built; tested against fakes, reclaim test plant-checked |
| **M3** | Next steps + timeline (Gemini) | Built; tested against fakes |
| **M4** | Recap page | Built; rendered with sample data, desktop and phone |
| **M5** | Setup guide + Marketplace listing | README setup written; listing with the Studio lane |

**Not yet proven against the real services.** Every step has run against fakes
(`scripts/check-recorder.ts`, 23 checks). The first real deploy, one real call
through Recall, Zernio, YouTube and Gemini, is the proof still owed.

## Open decisions

1. ~~YouTube path~~: Zernio, as production (decided 2026-09-21).
2. ~~Summarizer default~~: Gemini free tier, as production (decided 2026-09-21).
3. **Marketplace:** the listing under JakeScalesAI Studio on the Quartzi
   Marketplace is owned by the Studio lane. The listing points here once M5
   lands.
4. **Production:** does Quartzi move onto this package later, or keep its copy?
   Moving is cleaner long-term but is a separate, careful migration.
