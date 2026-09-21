# meeting-recorder

Record a video call, put the recording on YouTube (unlisted), and give the
client a recap page with the agreed next steps, the video and a timed breakdown
of the call. Each part is downloadable.

```
Recall.ai notetaker joins the call
        │
        ▼
Recording + transcript land in your database
        │
        ├──► Upload to YouTube, unlisted
        │      (the original is deleted from Recall only after YouTube
        │       itself confirms the video plays)
        │
        ├──► Summary: next steps + timeline of the call
        │
        ▼
Signed recap link:  /share/?id=…&sig=…
   next steps  →  YouTube player  →  timeline (click to seek)  →  downloads
```

It runs on Supabase: Postgres, Edge Functions and a cron job. The recap page is
a static site you can host anywhere.

## Status

**Early. Nothing here runs yet.** This repository is being extracted from a
production system (Quartzi's meetings at `meetings.quartzi.ai`). The plan, what
moves, in what order and what changes on the way out, is in
[docs/PLAN.md](docs/PLAN.md). Watch the repo or follow the milestones there.

## What you will need

- A Supabase project
- A [Recall.ai](https://www.recall.ai) API key (the notetaker bot)
- A [Zernio](https://zernio.com) account with your YouTube channel connected
  (this is how the recording is published)
- A YouTube channel **verified by phone**. Unverified channels cannot keep
  uploads longer than 15 minutes: YouTube accepts the upload and then refuses
  it. We learned this the hard way; see the plan.
- A free Google AI Studio key for Gemini (summary: `gemini-2.5-flash-lite`,
  next steps + timeline: `gemini-2.5-flash`).
  **Privacy:** on Gemini's free tier Google may use what you send (your call
  transcripts) to improve its products. For client calls, use a paid key.

## License

MIT. See [LICENSE](LICENSE).
