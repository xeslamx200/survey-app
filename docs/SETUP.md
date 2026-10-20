# Setup: Google Sheet + Apps Script backend

Time needed: about 10 minutes. You need a Google account. Respondents will **not** need one.

## 1. Create the Google Sheet

1. Go to <https://sheets.new> (or Google Drive → New → Google Sheets).
2. Name it, for example **Survey Responses**.
3. Leave it **private**. Do not use "Anyone with the link". The form does not need the sheet to be shared — the script writes to it on your behalf.

## 2. Add the backend script

1. In the sheet, open **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
2. Delete everything in `Code.gs` and paste the entire contents of [`apps-script/Code.gs`](../apps-script/Code.gs).
3. Show the manifest file: click **Project Settings** (gear icon) → tick **Show "appsscript.json" manifest file in editor**.
4. Go back to **Editor**, open `appsscript.json`, and replace its contents with [`apps-script/appsscript.json`](../apps-script/appsscript.json).
5. Rename the project (top left), e.g. **Survey Backend**, and press **Ctrl/⌘ + S**.

## 3. Configure (optional)

At the top of `Code.gs`:

| Setting | Default | When to change |
|---|---|---|
| `SPREADSHEET_ID` | `''` | Leave empty when the script was created from the sheet (step 2). Only fill it for a standalone script — and then also change the scope in `appsscript.json` to `https://www.googleapis.com/auth/spreadsheets`. |
| `SHEET_NAME` | `Responses` | Name of the tab that receives responses. |
| `TIMEZONE` | `Africa/Cairo` | Timezone for timestamps (any [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), e.g. `Asia/Qatar`, `Asia/Dubai`). Also change `timeZone` in `appsscript.json` to match. |
| `MIN_FILL_MS` | `3000` | Reject forms submitted within 3 s of opening the page. |
| `MAX_SUBMISSIONS_PER_MINUTE` | `30` | Global cap across all respondents. Raise it for large campaigns. |
| `MAX_PER_EMAIL_PER_HOUR` | `5` | Per-address cap. `0` disables. |

## 4. Initialize the sheet

1. In the toolbar's function dropdown choose **`setupSheet`**, then click **Run**.
2. Google asks you to authorize: **Review permissions** → choose your account.
   - You may see "Google hasn't verified this app". This is normal for your own scripts: click **Advanced → Go to Survey Backend (unsafe)**. The "app" is your own code.
   - The only permission requested is **"View and manage spreadsheets that this application has been installed in"** (`spreadsheets.currentonly`) — it can touch this one spreadsheet only.
3. The execution log should say something like `Sheet "Responses" is ready. Created the tab. Added headers: …`.
4. Back in the sheet you'll see a **Responses** tab with these frozen, bold headers:

   `Timestamp | Response ID | Name | Email | Phone | Age | Rating | Feedback | Consent`

`setupSheet` is safe to run again at any time. It never deletes, reorders or overwrites data; it only creates the tab, fills an empty header row, or appends missing headers on the right. It refuses to touch a tab whose first row holds unrelated headers.

You may delete the default empty **Sheet1** tab if you like.

## 5. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear next to "Select type" → **Web app**.
3. Fill in:
   - **Description:** `Survey v1`
   - **Execute as:** **Me** (your account)
   - **Who has access:** **Anyone**
4. Click **Deploy** and authorize again if asked.
5. Copy the **Web app URL**. It looks like
   `https://script.google.com/macros/s/AKfycb…/exec` — it must end in **`/exec`** (not `/dev`).

What these settings mean:

- **Execute as: Me** — the script runs with *your* permission to write to *your* sheet. Respondents never get access to the spreadsheet; they can only send data through the validated `doPost` function.
- **Who has access: Anyone** — anonymous visitors can call the URL without a Google sign-in. Required for a public survey. If your Google Workspace administrator has disabled this option, ask them to allow it, or use a personal Gmail account.

See [SECURITY.md](SECURITY.md) for the implications.

## 6. Test the backend on its own

**Health check:** open the `/exec` URL in a browser. You should see:

```json
{"ok":true,"service":"survey-backend","message":"Survey endpoint is running. Submit responses with POST."}
```

**Test submission** (macOS / Linux terminal — replace the URL):

```bash
curl -L -H 'Content-Type: text/plain;charset=utf-8' \
  -d '{"version":1,"submissionId":"curl-test-0000000001","answers":{"name":"Test Person","email":"test@example.com","rating":5,"feedback":"Backend test from curl","consent":true},"meta":{"elapsedMs":10000,"hp":""}}' \
  'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec'
```

`-L` is required: Apps Script answers with a redirect. Expected reply: `{"ok":true,"responseId":"R-…","timestamp":"…"}`, and a new row appears in the sheet. Running the identical command again returns the same `responseId` with `"duplicate":true` and does **not** add a second row. Delete the test row afterwards.

**Windows (PowerShell):**

```powershell
$body = '{"version":1,"submissionId":"ps-test-00000000001","answers":{"name":"Test Person","email":"test@example.com","rating":5,"feedback":"Backend test from PowerShell","consent":true},"meta":{"elapsedMs":10000,"hp":""}}'
Invoke-RestMethod -Method Post -ContentType 'text/plain;charset=utf-8' -Body $body -Uri 'https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec'
```

## 7. Connect the website

Open [`js/form-config.js`](../js/form-config.js) and paste the URL:

```js
endpoint: 'https://script.google.com/macros/s/AKfycb…/exec',
```

Then publish the site — see [DEPLOYMENT.md](DEPLOYMENT.md).

## Updating the script later

Saving code does **not** update the live Web App. After editing `Code.gs`:

**Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy.**

This keeps the same `/exec` URL. (Creating a *New deployment* instead gives you a new URL that you would have to paste into `form-config.js` again.)

## Adding or changing questions

1. Edit `sections` in `js/form-config.js` (examples for select, radio and multiple choice are included, commented out).
2. Add the matching entry to `FIELDS` in `Code.gs` with the same `id`, `type`, `required` and limits, plus a `header` (column name).
3. Run `npm test` — it fails if the two lists disagree.
4. Redeploy the script (new version) and republish the website.

New columns are appended to the right of the sheet automatically on the next submission (or run `setupSheet`). Existing rows are untouched; rows are written by header *name*, so you may reorder columns in the sheet.
