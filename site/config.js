// The two settings the pages need. Replace <project-ref> with your Supabase
// project ref.
//   api       the `recap` function: the recap page reads one meeting through it
//   recorder  the `recorder` function: the gallery lists meetings through it
window.RECAP_CONFIG = {
  api: "https://<project-ref>.supabase.co/functions/v1/recap",
  recorder: "https://<project-ref>.supabase.co/functions/v1/recorder",
};
