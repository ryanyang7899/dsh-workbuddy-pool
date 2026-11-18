Adds one plugin entry.

**Plugin:** [`ryanyang7899/dsh-workbuddy-pool`](https://github.com/ryanyang7899/dsh-workbuddy-pool) — Workbuddy account-pool meter for the DSH sidebar.

**What it does**

- One line in the sidebar footer: remaining credits for the whole Workbuddy account pool, with a status dot (idle / in flight / panel unreachable).
- Click it: which account is being called right now, which model, live tokens per second, today's spend in credits and tokens, and a per-account breakdown.
- A **Settings → Workbuddy** section with real controls: panel URL, panel API key, polling intervals and timeout — saved and applied without restarting the harness.

**How it differs from the existing `9963KK/workbuddy-monitor`**

That one estimates credit usage from the local WorkBuddy client. This one talks to a
**self-hosted [workbuddy2api](https://github.com/linguo2625469/workbuddy2api-panel) gateway panel** and answers a
different question: *which account in the pool is being called right now, on which model, at what generation
speed, and how much has the pool spent today.* Its data source is the panel's own `/panel/api/*` endpoints, so it
also works when several machines share one pool.

**Checklist**

- [x] `package.json` declares `dsh.bundle.patch` (plus `dsh.client` for the browser half)
- [x] `cordis.patch.yml` sits at the repo root and inserts the plugin row
- [x] Real, working code — host half (polling + JSON endpoints) and client half (sidebar widget + settings page), both hand-written ES modules
- [x] Only reads the panel's existing `/panel/api/*` endpoints; no write access, no credentials in config
- [x] Secret handling: the panel API key lives in a `0600` file, never in config, logs, or the snapshot sent to the page
- [x] Works with an unpatched panel too (degrades to last-request data instead of breaking)
- [x] MIT licensed

Happy to adjust the category (`usage` seemed closest to the existing `dsh-api-balance` entry) or the copy.
