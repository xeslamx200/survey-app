# Testing

## How to run

```bash
npm test                          # unit + backend tests (no install needed, Node 18+)

npm install                       # once, for browser tests
npx playwright install chromium   # once
npm run test:e2e                  # real-browser tests against the local mock backend

npm start                         # website on http://localhost:5173
                                  #   endpoint empty in form-config.js  → in-memory MOCK backend
                                  #   endpoint set in form-config.js    → your REAL Google backend
npm run start:mock                # always the in-memory MOCK (sheet: http://localhost:5174/__dev/rows)
```

## What runs where

| Level | What it exercises | Needs Google? |
|---|---|---|
| **Unit** — `tests/unit/validation.test.js` | Frontend validation and normalization (`js/validation.js`). | No |
| **Backend** — `tests/unit/backend.test.js` | The **real** `apps-script/Code.gs`, executed in a Node VM with in-memory mocks of SpreadsheetApp, LockService, CacheService, ContentService, Utilities. | No |
| **Sync** — `tests/unit/config-sync.test.js` | Frontend config and backend `FIELDS` match; both validators give the same verdict on ~60 inputs. | No |
| **Browser E2E** — `tests/e2e/survey.e2e.test.js` | Headless Chromium against `tools/dev-server.js`: website and mock Apps Script on **different origins**, `POST` answered with a **302 to another host**, **CORS preflight rejected** (as on Google). The mock runs the real `Code.gs`. | No |
| **Integration** — manual, below | Real Google Sheet + real Apps Script deployment + real hosting. | **Yes** |

The mocks reproduce Apps Script's documented behaviour; they cannot prove Google's servers behave identically. The manual checklist closes that gap.

## Results — executed 2026-10-20 (Node 22.22, Chromium 141, Linux)

**Unit + backend + sync: 38 / 38 passed.** **Browser E2E: 20 / 20 passed.**

As a sanity check that the browser tests can fail, I temporarily changed `app.js` to show success for any reply: 4 tests failed as expected (6a, 6b, 7c, 10), then the code was restored and all passed again.

### Required cases → evidence

| # | Required case | Result | Covered by |
|---|---|---|---|
| 1 | Empty form submission | ✅ Passed | Unit "empty form…"; E2E 1 (summary lists 5 problems, focus moves to it, `aria-invalid` set, **0 requests sent**) |
| 2 | Invalid email | ✅ Passed | Unit "invalid emails…" (8 bad, 3 good); E2E 2 (inline error, clears when fixed) |
| 3 | Missing required rating | ✅ Passed | Unit "rating…"; E2E 3 |
| 4 | Missing consent | ✅ Passed | Unit "consent is required"; E2E 4 |
| 5 | Valid submission | ✅ Passed (mock backend) | Backend "valid submission writes exactly one correct row"; E2E 5 (success only after `ok:true`; row content checked; exactly one `POST`, no `OPTIONS`; "submit another" makes a 2nd row) |
| 6 | Backend validation failure | ✅ Passed | Backend "field-level validation errors…", "wrong value types…"; E2E 6a (real server-only rule → error shown, no success), 6b (server field errors shown inline) |
| 7 | Network failure | ✅ Passed | E2E 7 (connection error, answers preserved, retry → exactly one row); 7b (timeout after the server saved → retry returns the same ID, **no duplicate**); 7c (HTML/sign-in page reply never shown as success) |
| 8 | Repeated Submit clicks | ✅ Passed | E2E 8 (button disabled + `aria-busy`; extra clicks, Enter and `requestSubmit()` → **one** request, one row) |
| 9 | Empty and oversized inputs | ✅ Passed | Unit "length limits", "whitespace-only…"; Backend "oversized request body", "oversized individual fields"; E2E 9 |
| 10 | Unexpected fields in backend requests | ✅ Passed | Backend "unexpected extra fields are ignored and never stored" (forged `Timestamp`/`Response ID`/`isAdmin` not stored, no new columns), "malformed requests…" (9 cases) |
| 11 | Multiple simultaneous submissions | ✅ Passed (mock) · ⚠️ needs real check | Backend "many submissions…" (50 rows, unique IDs), "lock…" tests; E2E 11 (10 browsers at once → 10 rows, 10 unique IDs). Node serializes requests, so true parallel locking on Google's servers is part of the manual checklist. |
| 12 | Successful insertion into Google Sheets | ⚠️ Requires your deployment | Verified against the in-memory sheet only. See manual step M4. |
| 13 | Existing data preserved during setup | ✅ Passed (mock) | Backend "setupSheet preserves existing data and only appends missing headers", "…refuses a tab with unrelated headers", "running it again changes nothing" |
| 14 | Mobile layout & keyboard accessibility | ✅ Passed | E2E 13 (skip link, full form + submit by keyboard, focus ring, honeypot not focusable); E2E 14 (375 px & 768 px: no horizontal scroll, 16 px inputs, ≥44 px rating targets); E2E 15 (contrast ≥ 4.5:1 for 11 text styles); E2E 16 (reduced motion) |

Additional backend checks that passed: formula injection neutralized; honeypot drops silently; `TOO_FAST`; idempotent retry; global and per-email rate limits (emails hashed in cache keys); lock released even when the write throws; internal error details never returned to the client; health check.

### Screenshots (generated by the E2E run)

`docs/screenshots/desktop.png`, `validation-errors.png`, `success.png`, `network-error.png`, `mobile.png`, `mobile-errors.png`.

### Not tested here

- An automated accessibility scanner (axe-core) could not be installed in the build environment (package registry blocked). Accessible names, keyboard flow, focus visibility and contrast were checked by the custom tests above. Consider a screen-reader pass (VoiceOver/NVDA) before launch.
- Browsers other than Chromium (Safari/iOS, Firefox) — check manually (M7).

## Manual integration checklist (needs your Google account)

Do these once after deploying. Tick each.

- [ ] **M1** Open the `/exec` URL in an incognito window → health-check JSON shows (proves *Anyone* access).
- [ ] **M2** Run the curl test in [SETUP.md §6](SETUP.md#6-test-the-backend-on-its-own) → `ok:true`, a row appears. Run it again → same `responseId`, `"duplicate":true`, no second row.
- [ ] **M3** Open the published site in an incognito window, submit empty → errors, and nothing in the sheet.
- [ ] **M4** Submit a valid response → success screen with Response ID; the same ID is in the sheet; Timestamp shows your timezone; Phone shows `+20…` (no visible apostrophe); Consent = `Yes`.
- [ ] **M5** Enter `=1+1` as the name → the sheet shows the text `=1+1`, not `2`.
- [ ] **M6** Open the site on 3–5 devices/tabs and submit at the same moment → all rows present, no overwrites, unique IDs.
- [ ] **M7** Submit from Safari on iPhone and from Firefox → success, rows present.
- [ ] **M8** Turn on airplane mode, submit → "Connection problem", answers kept; reconnect, **Try again** → one row.
- [ ] **M9** Add a dummy row and a manual "Notes" column to the sheet, run `setupSheet` again → nothing changes or disappears.
- [ ] **M10** Check **Apps Script → Executions**: no failed runs. Delete all test rows.
