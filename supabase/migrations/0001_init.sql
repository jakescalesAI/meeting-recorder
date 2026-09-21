-- meeting-recorder schema. One file, applied once.
--
-- Everything is read and written by the edge functions with the service role.
-- RLS is on with NO policies, so the anon key (which ships to browsers) can read
-- nothing here. The recap page never talks to the database; it calls the
-- `recap` function with a signed link.

create extension if not exists pgcrypto;

-- One row per recorded call.
create table if not exists public.meetings (
  id                uuid primary key default gen_random_uuid(),
  -- One install can serve several brands. Single users never change it.
  org               text not null default 'default',
  recall_bot_id     text unique,
  title             text,
  meeting_url       text,
  started_at        timestamptz,
  ended_at          timestamptz,

  -- Transcript as plain "Speaker: text" lines. Timed lines live in
  -- transcript_entries.
  full_text         text,

  -- Publishing to YouTube through Zernio.
  --   pending     recording is ready, not uploaded yet
  --   publishing  Zernio accepted it; YouTube is still processing
  --   published   YouTube URL known
  --   failed      upload failed; retried until publish_attempts hits the cap
  publish_status    text not null default 'pending'
                    check (publish_status in ('pending', 'publishing', 'published', 'failed')),
  publish_attempts  integer not null default 0,
  publish_post_id   text,
  publish_error     text,
  published_at      timestamptz,
  youtube_url       text,

  -- The Recall original is deleted only after YouTube itself confirms the video
  -- plays (see reclaim in supabase/functions/recorder). Until then it is kept.
  recall_media_deleted_at timestamptz,
  reclaim_note      text,

  -- Next steps + timed sections, written by Gemini.
  timeline          jsonb,
  timeline_at       timestamptz,
  timeline_attempts integer not null default 0,
  timeline_error    text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists meetings_org_started on public.meetings (org, started_at desc);
create index if not exists meetings_publish_status on public.meetings (publish_status);

-- One row per transcript line, with the real time into the call from Recall's
-- word timestamps. This is what lets the timeline show exact times.
create table if not exists public.transcript_entries (
  id          bigserial primary key,
  meeting_id  uuid not null references public.meetings (id) on delete cascade,
  seq         integer not null,
  speaker     text,
  text        text not null,
  start_sec   numeric,
  unique (meeting_id, seq)
);

-- Per-brand settings. The 'default' row is used when a meeting's org has none.
create table if not exists public.recorder_settings (
  org                text primary key,
  -- The Zernio account id of the YouTube channel recordings publish to.
  -- Nothing publishes until this is set: uploading someone's calls to a channel
  -- is an outward action that waits for a human to choose where.
  youtube_account_id text,
  brand_name         text,
  logo_url           text,
  accent_color       text,
  -- Where the recap page is hosted, e.g. https://meetings.example.com
  recap_site_url     text,
  updated_at         timestamptz not null default now()
);

insert into public.recorder_settings (org) values ('default') on conflict (org) do nothing;

alter table public.meetings           enable row level security;
alter table public.transcript_entries enable row level security;
alter table public.recorder_settings  enable row level security;
