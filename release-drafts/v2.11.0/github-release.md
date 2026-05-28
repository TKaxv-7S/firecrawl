# Firecrawl v2.11.0

## Improvements

- **Monitor goals with LLM judge** — Added `goal` and `judgeEnabled` to monitors. When a goal is set, every changed page is run through an LLM judge that labels the diff `meaningful` or `noise` against the goal, drops alert spam, sorts meaningful pages first in summary emails, and renders the unified diff inline with color cues for up to five meaningful pages. Surfaced on monitor GET/responses and exposed in JS, Python, Java, .NET, Go, PHP, Ruby, Rust, and Elixir SDKs. Judge calls cost +1 credit per judged page; monthly estimates double when `judgeEnabled` is on.
- **Monitor JSON diffs** — Monitors that scrape with `{type: "json"}` or `{type: "changeTracking", modes: ["json"]}` now compute field-level JSON diffs against the previous run instead of diffing the rendered markdown. Each check persists a `snapshot.json` of current field values alongside the diff, available through `GET /v2/monitor/:id/checks/:checkId` and typed in the JS, Python, Java, .NET, Go, PHP, Ruby, and Rust SDKs.
- **Mixed-mode change tracking** — Monitors requesting both `["json", "git-diff"]` modes now run both diffs and report `changed` whenever either side changes, with the markdown unified diff attached as a sidecar on the JSON artifact. Previously this combination silently returned `same` when only one side moved.
- **Monitor `meaningfulChange` field** — Judge output now includes a `meaningfulChange` (and `meaningfulChanges[]` per-page) field carrying the verbatim diff text the judge flagged as meaningful, plus a per-change reason. Surfaced in monitor check pages, webhooks, and the JS, Python, Go, Java, .NET, PHP, Ruby, and Rust types.
- **Monitor email confirmation** — External monitor recipients now go through an opt-in confirmation flow with one-click unsubscribe; team members are auto-confirmed. `POST /v2/monitor/email/confirm` and `POST /v2/monitor/email/unsubscribe` accept a token in the request body, and `Monitor` responses include `emailRecipientSubscriptions` so callers can see who is `pending`, `confirmed`, or unsubscribed.
- **AM/PM monitor schedules** — Daily monitor schedules now accept 12-hour inputs like `daily at 9am`, `daily at 9:30am`, and `daily at 5:30pm`, and convert them to the correct UTC cron expression.
- **Monitor webhook delivery status** — `GET /v2/monitor/:id/checks` and `GET /v2/monitor/:id/checks/:checkId` now overlay the latest webhook delivery from `webhook_logs`, surfacing `attempted`, `delivered`, `statusCode`, `error`, and `deliveredAt` on each check.
- **Monitor default wait & timeout** — Monitor scrapes now default `waitFor` to 5 s and `timeout` to `2× waitFor`, clamped to 120 s, to cut false positives caused by partially-rendered pages. Defaults apply only when the caller does not pass `waitFor` or `timeout`.
- **Monitor judge timeout** — Per-attempt judge timeout raised from 8 s to 30 s to absorb slower model responses without flaky timeouts. Retry count and backoff are unchanged.
- **Monitor scheduler jitter** — Added a deterministic per-monitor offset to the scheduler claim so checks are staggered within their interval instead of all firing at the top of the minute, smoothing load spikes during heavy fan-out.
- **`PDF size cap`** — Raised the PDF download and scrape cap from 30 MB to 50 MB.
- **X/Twitter scrape billing** — Updated X/Twitter scrapes to 29 credits per request (up from 9) to reflect the cost of the underlying provider.
- **JS SDK string API key** — `new Firecrawl("fc-key")` now works alongside `new Firecrawl({ apiKey: "fc-key" })`. The constructor accepts a bare string and trims whitespace; whitespace-only keys are rejected with a clear error.
- **JS SDK V2 prototype discoverability** — V2 methods like `scrape`, `search`, `crawl`, `map`, and `parse` are now installed on `Firecrawl.prototype` at module load so agent runtimes that introspect via `Object.getPrototypeOf(app)` can see them.
- **V1 method aliases on V2 SDKs** — Added deprecated `scrape_url`/`scrapeUrl`, `crawl_url`/`crawlUrl`, and matching aliases on V2 Python and JS clients so callers trained on V1 docs keep working instead of hitting `AttributeError`/`TypeError`. Aliases match the V1 `id` parameter name on status/error helpers.
- **Python SDK `crawl()` scrape kwargs** — `crawl()` and `start_crawl()` (sync and async) now accept the same direct kwargs as `scrape()` and `batch_scrape()` (`formats`, `headers`, `include_tags`, `exclude_tags`, etc.), removing the need to wrap them in `ScrapeOptions(...)`. `start_crawl()` now also forwards `timeout`.
- **`SearchData.data` guidance** — Accessing `.data` on a search result now raises a clear error pointing at `.web`, `.news`, and `.images` with their counts, so LLM agents that hallucinate `.data` get an actionable message instead of a silent `None`.
- **Python `JsonFormat`/`ChangeTrackingFormat` defaults** — `JsonFormat(prompt="...")` and `ChangeTrackingFormat(modes=[...])` no longer require an explicit `type=` argument; both now default `type` like `ScreenshotFormat` does.
- **`ChangeTrackingFormat` case acceptance** — SDKs now accept both `change_tracking` and `changeTracking` for the format `type` field so payloads round-trip between snake_case and camelCase clients without re-mapping.
- **Python SDK monitor `goal` / `judge_enabled`** — `FirecrawlClient.create_monitor()` and `update_monitor()` (sync and async) accept `goal` and `judge_enabled` kwargs directly, matching the new `/v2/monitor` request shape.

## Fixes

- Resolved CVEs across the API and SDKs by patching `ws` to `8.20.1` (GHSA-58qx-3vcg-4xpx), `brace-expansion` to `5.0.6` (GHSA-jxxr-4gwj-5jf2), `qs` (GHSA-Q8MJ-M7CP-5Q26 / CVE-2026-8723), `uuid` to `11.1.1` (GHSA-W5HQ-G745-H8PQ), and `js-cookie` (GHSA-QJX8-664M-686J) via pnpm overrides across `apps/api`, `apps/js-sdk`, `apps/playwright-service-ts`, `apps/test-suite`, and `apps/ui/ingestion-ui`.
- Fixed `cancel` on `/v1` and `/v2` crawls and batches not draining the per-team concurrency-limit backlog — queued job IDs are now removed via a chunked Redis pipeline and `status` reports `cancelled` immediately, even while the worker group is still draining.
- Fixed crawls being silently capped at 0 when a team had 0 credits but Autumn allowed the request via overage — `crawlerOptions.limit` now honors the caller's value when Autumn returns `{ allowed: true }`.
- Fixed credit checks falling back to legacy ACUC accounting when the Autumn API failed — Autumn is now the source of truth and a failed check returns an error instead of silently allowing requests on diverged ACUC balances.
- Fixed sync `Firecrawl.search()` in the Python SDK raising `TypeError: ... unexpected keyword argument 'include_domains'` when callers passed `include_domains` or `exclude_domains` — the sync signature now matches the async client and the wire payload.
- Fixed JSON-mode monitor diffs returning spurious `changed` verdicts when the underlying scrape returned identical field values in a different order — diffs now use deep, order-insensitive equality.
- Fixed JSON-mode monitors treating an empty-string markdown scrape as missing input — pages that legitimately render no text now report `same` on subsequent runs instead of staying perpetually `changed`.
- Fixed monitor webhooks being dispatched twice for the same check by gating notifications on a per-check Redis NX claim (7-day TTL) across run, stale, and reconcile paths.
- Fixed monitor webhooks being dead-lettered as `malformed_json` by the Rust dispatcher — `monitor.page` and `monitor.check.completed` payloads now wrap `data` in an array, matching the existing crawl/batch shape.
- Fixed the monitor judge fabricating before/after text by passing only the rendered markdown diff as evidence and tightening the prompt to require quotes from that diff.
- Fixed the monitor judge missing context on long pages by removing input truncation — the full unified diff and page content are now sent to the judge instead of being clipped.
- Hardened monitor check responses against corrupt or unexpected artifact payloads in GCS — bad data now surfaces as no diff instead of breaking `GET /v2/monitor/:id/checks/:checkId`.
- Fixed PDF size-cap enforcement being bypassed on certain scrape paths so PDFs over the limit are now rejected consistently.
- Fixed fire-engine not classifying "file size exceeds limit" responses as a recognized error type, so callers get a structured rejection instead of a generic failure.
- Fixed `ChangeTrackingFormat` options being dropped through Python SDK serialization round-trips — `modes`, `prompt`, and related fields now survive `model_dump()` / re-instantiation.

## API

- Added `goal: string|null` and `judgeEnabled: boolean` to `POST /v2/monitor` and `PATCH /v2/monitor/:id`. `judgeEnabled` defaults to `true` when `goal` is non-empty; passing `goal: null` clears it.
- Added `judgment` and `meaningfulChange` to monitor check pages on `GET /v2/monitor/:id/checks/:checkId`, plus a per-change `reason` and the `meaningfulChanges[]` array. Typed in the JS, Python, Java, .NET, Go, PHP, Ruby, Rust, and Elixir SDKs.
- Added a structured `diff` object (`text` and/or `json`) and a `snapshot` field to `MonitorCheckPage`. JSON-mode checks return field-level diffs plus a current-value snapshot; markdown-mode checks continue to return a text diff.
- Added `POST /v2/monitor/email/confirm` and `POST /v2/monitor/email/unsubscribe`. Both are unauthenticated, accept the token only in the request body (query-string tokens are rejected), and use `invalid_token` (400) and `not_found` (404) error codes.
- Added `emailRecipientSubscriptions` to `Monitor` responses on `GET /v2/monitor/:id` and on create/update. Each entry reports `email`, `status` (`pending` | `confirmed` | `unsubscribed`), `source`, and `confirmationEmailSent`.
- Changed the monitor webhook payload so `monitor.page` and `monitor.check.completed` events wrap `data` in an array. `monitor.page` now includes `isMeaningful` (`boolean | null` for changed pages), `judgment`, and a `diff` object with `text` and/or `json`.
- Added `origin: string` to monitor create/update bodies, matching every other v2 endpoint; SDKs now auto-inject `origin` on these calls.
- Added 12-hour AM/PM parsing for daily monitor schedules — strings like `9:30am` and `5pm` are accepted and converted to 24-hour cron.
- Normalized monitor `scrapeOptions.formats` so `{type: "changeTracking", modes: ["json"]}` is rewritten to `{type: "json"}` before scraping, and the mixed-mode `["json", "git-diff"]` form runs both diffs instead of silently falling back to one.
- Added `include_domains` and `exclude_domains` keyword arguments to the Python SDK's sync `Firecrawl.search()` to bring it in line with `AsyncFirecrawl.search()` and the `/v2/search` wire payload.
- Added V1-compatible method aliases (`scrape_url`/`scrapeUrl`, `crawl_url`/`crawlUrl`, `batch_scrape_urls`/`batchScrapeUrls`, `extract`, `map_url`/`mapUrl`, and their status/error helpers) on V2 Python and JS clients. Aliases emit a `DeprecationWarning`.
- Changed X/Twitter scrape billing from 9 to 29 credits per scrape.
- Changed monitor billing: each judged changed page now consumes +1 credit when `judgeEnabled` is on, and monthly credit estimates double when `judgeEnabled` is enabled at create/update.

---

**Full Changelog**: https://github.com/firecrawl/firecrawl/compare/v2.10...v2.11.0
