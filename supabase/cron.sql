-- Run the sweep every 10 minutes. Paste into the Supabase SQL editor after
-- replacing the two placeholders. Needs the pg_cron and pg_net extensions
-- (Database -> Extensions).
--
-- The secret is stored in Vault, not in the job text, so it never shows up in
-- cron.job listings.

select vault.create_secret('<RECORDER_SECRET>', 'recorder_secret');

select cron.schedule(
  'meeting-recorder-sweep',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/recorder?action=sweep',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-recorder-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'recorder_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
