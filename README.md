# pawl
pawl stops Claude Code from quietly weakening your app’s security. It snapshots the controls you already have (Next.js route auth, Supabase row-level security, CORS, security headers) and blocks any commit that removes or loosens one unless you accept the change with a reason. Deterministic, local, no LLM calls. Built for vibe coders.
