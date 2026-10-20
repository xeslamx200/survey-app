# Security, privacy and limitations

This survey is public: anyone can load the page and anyone can send requests straight to the Apps Script URL without using the page at all. Everything below assumes requests can be forged.

## What protects the data

| Layer | Protection |
|---|---|
| **Spreadsheet access** | The sheet stays private. Respondents never get access; the script writes on the owner's behalf (*Execute as: Me*). Nobody can *read* responses through the endpoint — it only accepts writes and returns the new row's ID. |
| **Minimal scope** | `appsscript.json` requests only `spreadsheets.currentonly`: the script can touch the one spreadsheet it is attached to, nothing else in your Drive. |
| **Server-side validation** | `Code.gs` re-validates every field independently of the browser: required fields, types, email/phone format, integer ranges, allowed option values, min/max length (in characters). Objects/arrays where text is expected are rejected. |
| **Unknown fields dropped** | Only fields listed in `FIELDS` are stored. Extra keys (e.g. `isAdmin`, a forged `Timestamp`) are ignored and never create columns. |
| **Size limits** | Request bodies over 20,000 characters are rejected before parsing; each field has its own length limit. |
| **Normalization** | Unicode NFC, control characters stripped, whitespace trimmed, emails lowercased. |
| **Formula injection** | Text starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with an apostrophe so Sheets stores it as text instead of executing it (e.g. `=HYPERLINK(...)` or `=IMPORTXML(...)` in a name field). |
| **Server-generated values** | Timestamp and Response ID are created on the server; clients cannot set them. |
| **Concurrency** | Writes happen inside `LockService.getScriptLock()` and use `appendRow`, so simultaneous submissions don't overwrite each other. The lock is always released (`finally`). |
| **No double rows on retry** | Each form fill gets a random `submissionId`. The server remembers it for 6 hours (`CacheService`); a retry after a timeout returns the original Response ID instead of writing again. |
| **Error hygiene** | Clients only ever see short, generic messages and an error code. Stack traces and internal details go to the owner's private execution log (Apps Script → Executions). |
| **Browser hardening** | Content-Security-Policy allows scripts only from the site itself and network calls only to Google Apps Script; `form-action 'none'`; no inline scripts; all rendering via `textContent` (no `innerHTML`), so configuration or server text cannot inject HTML. |
| **Honest success** | The page shows "Thank you" only when the server's JSON says `ok: true` with a Response ID. Network errors, timeouts, HTML pages (e.g. a Google sign-in redirect) and malformed replies show an error and keep the answers. |

## Abuse mitigation — and its limits

| Measure | What it stops | What it does **not** stop |
|---|---|---|
| **Honeypot field** (`hp_field`, hidden off-screen) | Naive bots that fill every input. They receive a fake success; nothing is written. | Any bot that reads the HTML or targets the API directly. |
| **Minimum fill time** (`MIN_FILL_MS`, 3 s) | Scripts that submit instantly through the page. | Forged requests — `elapsedMs` is reported by the client and can be faked. |
| **Global rate limit** (`MAX_SUBMISSIONS_PER_MINUTE`) | Floods that would fill the sheet or exhaust quotas. | It also blocks legitimate users during a flood. Apps Script **cannot see IP addresses**, so there is no per-IP limit. |
| **Per-email limit** (`MAX_PER_EMAIL_PER_HOUR`) | One person submitting repeatedly with the same address. | Attackers who vary the email. Emails are hashed (SHA-256) in the cache key. |

**These are speed bumps, not spam protection.** A determined attacker can write a script that posts valid-looking data to the `/exec` URL. If that matters for your survey:

1. **Add a CAPTCHA with server verification** — Cloudflare Turnstile (free) or Google reCAPTCHA. The page gets a token from the widget and includes it in the payload; `Code.gs` verifies it with `UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', …)` and rejects on failure. Costs: one more script permission (`script.external_request`), a secret key stored in **Project Settings → Script properties** (never in frontend code), and a third-party widget on the page (update the CSP and privacy notice).
2. **Put a proxy in front** — e.g. a Cloudflare Worker that does per-IP rate limiting, origin checks and Turnstile verification, then forwards to Apps Script with a shared secret. Stronger, but adds infrastructure (free tier usually suffices).
3. **Use a dedicated form/backend service** if you need guaranteed throughput, audit trails or compliance features.

None of these are implemented by default to keep the project dependency- and cost-free. Ask before adding them.

## Other limitations of a public Apps Script endpoint

- **Quotas.** Google limits simultaneous executions (about 30 per user for web apps) and daily script runtime. Consumer accounts and Workspace accounts have different limits — see Google's "Quotas for Google Services" page. Fine for typical surveys (thousands of responses/day); not built for viral, high-burst traffic. Under heavy load the lock wait (10 s) may expire → users see "The server is busy" and can retry safely.
- **Latency.** Each submission typically takes 1–3 s (cold starts can be slower). The page shows a loading state and times out after 20 s, after which a retry is idempotent.
- **No custom HTTP status codes or CORS headers.** `ContentService` always returns HTTP 200 and cannot answer CORS preflight requests. See the next section for how the app works within that.
- **CacheService is best-effort.** Rate-limit counters and idempotency records can be evicted early. In the rare case a cache entry disappears *and* the user retries after a timeout, a duplicate row is possible (the Response IDs will differ; delete one).
- **The endpoint URL is public.** It has to be — browsers call it. Treat it like a public form address. If it's abused, create a new deployment (new URL), update `form-config.js`, and archive the old deployment.
- **Sheets limits.** A spreadsheet holds up to 10 million cells; with 9 columns that's ~1.1 million responses. Archive old rows to another file well before that.

## Cross-origin requests: how the browser gets a readable answer

The website (e.g. `github.io`) and Apps Script (`script.google.com`) are different origins.

- Apps Script cannot respond to CORS **preflight** (`OPTIONS`) requests. A `fetch` with `Content-Type: application/json` would trigger one and fail. The app therefore sends JSON text with **`Content-Type: text/plain;charset=utf-8`** — a CORS-safelisted "simple" request — so no preflight is sent. The server parses the body with `JSON.parse` regardless of the header.
- Apps Script answers `POST /exec` with a **302 redirect** to `script.googleusercontent.com`; `fetch` follows it automatically (`redirect: 'follow'`), and that final response carries `Access-Control-Allow-Origin: *`, so the page can **read the JSON** and confirm the result. `credentials: 'omit'` is required for `*` to be accepted.
- The app never uses `mode: "no-cors"`. That mode produces an *opaque* response the page cannot read, so it could never know whether the row was saved.
- Alternatives considered: JSONP via `doGet` (Google's docs warn it exposes data to any embedding site, and it would put personal data in URLs and server logs — rejected); a hidden `<form>` posting into an `<iframe>` (works without CORS but the page cannot read the result — rejected); a proxy such as a Cloudflare Worker (reliable, but extra infrastructure — only if needed).

This behaviour is reproduced locally by `tools/dev-server.js` (different origin, 302 to another host, preflights rejected) and covered by the browser tests. It still needs to be confirmed once against your real deployment — see [TESTING.md](TESTING.md).

## Privacy

- Collect only what you need. Phone and age are optional; remove them from both `form-config.js` and `Code.gs` if you don't use them.
- The privacy notice and consent text are placeholders. **Adapt them to your organisation and local law** (e.g. who the controller is, purpose, retention period, how to request deletion). This project does not by itself make you compliant with GDPR, Qatar's PDPPL, the UAE PDPL, Egypt's Law 151/2020 or any other regulation.
- Responses live in your Google account and are subject to Google's terms. Share the spreadsheet only with people who need it; prefer "Viewer" access.
- To delete a person's data, delete their row(s). Use the Response ID they were given to find it.
- Never add password, payment-card or government-ID fields to this form.
- No analytics, cookies or third-party scripts are included. If you add any, update the CSP and privacy notice.

## Checklist before going live

- [ ] Spreadsheet sharing is **Restricted** (not "Anyone with the link").
- [ ] Deployment: *Execute as: Me*, *Who has access: Anyone*, URL ends in `/exec`.
- [ ] Privacy notice and consent wording reviewed for your organisation.
- [ ] Rate limits suit your expected traffic.
- [ ] A test response from an incognito window landed in the sheet, and was deleted.
- [ ] You know where to look when something fails: Apps Script → **Executions**.
