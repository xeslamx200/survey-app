# Deployment: publish the website

Do [SETUP.md](SETUP.md) first so you have the Apps Script `/exec` URL in `js/form-config.js`.

The website is static (HTML, CSS, JS — no build step), so any static host works. Two options are described: **GitHub Pages** (recommended, free, versioned) and **Netlify Drop** (fastest, no Git).

Only these files are needed on the public site:

```
index.html
css/styles.css
js/form-config.js
js/validation.js
js/app.js
```

---

## Option A — GitHub Pages (recommended)

The repository includes a workflow, [`.github/workflows/deploy-pages.yml`](../.github/workflows/deploy-pages.yml), that runs the unit tests and then publishes **only** the five files above. Tests, tools and the Apps Script source are not published.

1. Create a new repository on <https://github.com/new> (public, or private on a paid plan). Don't add a README.
2. Push the project (in the project folder):

   ```bash
   git add .
   git commit -m "Survey app"
   git branch -M main
   git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
   git push -u origin main
   ```

   No terminal? On the repo page use **Add file → Upload files** and drag in the whole folder contents (including the hidden `.github` folder).
3. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Open the **Actions** tab. The **Deploy survey to GitHub Pages** run should finish green in about a minute (re-run it from the Actions tab if it ran before step 3).
5. Your survey is at `https://YOUR-USER.github.io/YOUR-REPO/`. The URL is also shown in **Settings → Pages**.

Every later push to `main` re-runs the tests and redeploys.

> Repository visibility: on GitHub's free plan the repository must be public for Pages. That is fine — nothing in this project is secret. Keep `SPREADSHEET_ID` empty (the default) so not even the sheet ID is in the repo; the `/exec` URL is necessarily public because browsers call it.

## Option B — Netlify Drop (no Git)

1. Make a folder containing only `index.html`, `css/` and `js/`.
2. Go to <https://app.netlify.com/drop> and drag that folder onto the page.
3. Netlify gives you a URL like `https://random-name.netlify.app`. Create a free account to keep the site and rename it under **Site configuration → Change site name**.

To update, drag the folder again onto **Deploys** in your site's dashboard.

---

## Verify the live site

1. Open the public URL in a **private/incognito window** (no Google sign-in) and on a phone.
2. Submit once with empty fields → errors appear, nothing is sent.
3. Submit a real test response → the green "Thank you" screen shows a reference like `R-20261020-3F9A1C2B7D`.
4. Open the Google Sheet → a new row with the same Response ID.
5. Delete the test row.

The site is live only once step 4 succeeds.

## Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| "This survey is not connected yet" | `endpoint` in `js/form-config.js` is empty or not `https://…`. Paste the `/exec` URL and republish. |
| "Connection problem" for everyone | Deployment access isn't **Anyone** (anonymous visitors get redirected to a Google sign-in page, which the browser blocks), or the URL ends in `/dev`. Redeploy with *Who has access: Anyone* and use the `/exec` URL. The browser console (F12) shows a hint. |
| "We couldn't confirm your response" | The endpoint returned something that isn't the expected JSON (wrong URL, or a Google error page). Open the `/exec` URL directly — it must show the health-check JSON. |
| Works in curl, fails in the browser | Check the browser console for a Content-Security-Policy error. If you host on a custom domain or proxy, add it to `connect-src` in `index.html`. |
| Edited `Code.gs` but nothing changed | You must publish a new **version** of the existing deployment (Deploy → Manage deployments → Edit → New version). |
| "Something went wrong on our side" | Open **Apps Script → Executions** to see the logged error. Common: the `Responses` tab has unrelated headers in row 1, or you set `SPREADSHEET_ID` without switching the scope to `spreadsheets`. Run `setupSheet` to see the message. |
| Exception: "You do not have permission to call SpreadsheetApp.openById" | You set `SPREADSHEET_ID` but kept the `spreadsheets.currentonly` scope. Change the scope in `appsscript.json`, run `setupSheet` to re-authorize, and redeploy a new version. |
| "Too many responses right now" during a big launch | Raise `MAX_SUBMISSIONS_PER_MINUTE` in `Code.gs` and redeploy a new version. |
| Old page still shown after an update | Browser or CDN cache. Hard-refresh (Ctrl/⌘ + Shift + R); GitHub Pages can take a minute to update. |
| Workspace account: "Anyone" option missing | Your admin restricts public web apps. Ask them, or deploy from a personal Google account. |

## Custom domain (optional)

- GitHub Pages: **Settings → Pages → Custom domain**, then add the DNS record GitHub shows.
- Netlify: **Domain management → Add a domain**.

No code change is needed; the CSP in `index.html` restricts what the page may *connect to*, not where it's served from.
