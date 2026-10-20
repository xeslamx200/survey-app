'use strict';
/**
 * End-to-end tests in a real headless Chromium against tools/dev-server.js.
 * The mock Apps Script runs the real Code.gs, lives on a different origin,
 * answers POST with a 302 to another host, and rejects CORS preflights —
 * the same constraints as production.
 *
 * Run: npm run test:e2e   (needs `npm install` + `npx playwright install chromium`)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { start } = require('../../tools/dev-server');

const SHOTS = path.join(__dirname, '..', '..', 'docs', 'screenshots');
const WEB_PORT = 5273;
const API_PORT = 5274;

let server;
let browser;

test.before(async () => {
  server = await start({ quiet: true, webPort: WEB_PORT, apiPort: API_PORT });
  browser = await chromium.launch();
  fs.mkdirSync(SHOTS, { recursive: true });
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/* ---------------- helpers ---------------- */

async function dev(pathname, body) {
  const res = await fetch(server.apiUrl + pathname, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}
async function resetBackend(config = { MIN_FILL_MS: 0 }, delayMs = 0) {
  await dev('/__dev/config', { config, delayMs });
  await dev('/__dev/reset', {});
  await dev('/__dev/config', { config, delayMs });
}
const sheet = () => dev('/__dev/rows');

async function openPage(opts = {}) {
  const context = await browser.newContext(opts.context || { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  const requests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('request', (r) => { if (r.url().includes('/exec')) requests.push(r.method()); });
  await page.goto(server.webUrl + '/');
  await page.waitForSelector('#f-name');
  return { page, context, consoleErrors, requests };
}

async function fillValid(page, over = {}) {
  const v = Object.assign({
    name: 'Sara Ahmed', email: 'sara@example.com', phone: '+20 100 123 4567', age: '32',
    rating: '4', feedback: 'Fast delivery and friendly support team.', consent: true
  }, over);
  await page.getByLabel('Full name').fill(v.name);
  await page.getByLabel('Email address').fill(v.email);
  await page.getByLabel('Phone number').fill(v.phone);
  await page.getByLabel('Age').fill(v.age);
  if (v.rating) await page.locator(`#f-rating-${v.rating}`).check();
  await page.getByLabel('What is the main reason for your rating?').fill(v.feedback);
  if (v.consent) await page.locator('#f-consent').check();
}

const submit = (page) => page.getByRole('button', { name: /submit response/i }).click();

/* ---------------- tests ---------------- */

test('renders all fields with accessible names, privacy notice, no console/CSP errors', async () => {
  await resetBackend();
  const { page, context, consoleErrors } = await openPage();
  for (const name of ['Full name', 'Email address', 'Phone number', 'Age', 'What is the main reason for your rating?']) {
    assert.equal(await page.getByLabel(name).count(), 1, name);
  }
  assert.equal(await page.getByRole('radio').count(), 5);
  assert.equal(await page.getByRole('radio', { name: '5 – Excellent' }).count(), 1);
  assert.equal(await page.getByRole('checkbox', { name: /I agree/ }).count(), 1);
  assert.equal(await page.getByRole('group', { name: /how satisfied/i }).count(), 1);
  assert.match(await page.locator('.privacy').innerText(), /private Google Sheet/);
  assert.match(await page.title(), /Customer Experience Survey/);
  await page.screenshot({ path: path.join(SHOTS, 'desktop.png'), fullPage: true });
  assert.deepEqual(consoleErrors, []);
  await context.close();
});

test('1. empty submission: summary lists 5 problems, fields flagged, nothing sent', async () => {
  await resetBackend();
  const { page, context, requests } = await openPage();
  await submit(page);
  const summary = page.locator('#error-summary');
  await summary.waitFor();
  assert.match(await summary.innerText(), /fix 5 problems/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'error-summary');
  assert.equal(await page.locator('#f-name').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#f-phone').getAttribute('aria-invalid'), null, 'optional field not flagged');
  assert.deepEqual(requests, []);
  await page.screenshot({ path: path.join(SHOTS, 'validation-errors.png'), fullPage: true });
  // clicking a summary link focuses the field
  await summary.getByRole('link', { name: /^Email —/ }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-email');
  await context.close();
});

test('2. invalid email shows an inline error that clears once fixed', async () => {
  await resetBackend();
  const { page, context, requests } = await openPage();
  await fillValid(page, { email: 'sara@example' });
  await submit(page);
  assert.match(await page.locator('#email-error').innerText(), /valid email/);
  assert.deepEqual(requests, []);
  await page.getByLabel('Email address').fill('sara@example.com');
  assert.equal(await page.locator('#email-error').innerText(), '');
  assert.equal(await page.locator('#f-email').getAttribute('aria-invalid'), null);
  await context.close();
});

test('3. missing rating is caught', async () => {
  await resetBackend();
  const { page, context, requests } = await openPage();
  await fillValid(page, { rating: null });
  await submit(page);
  assert.match(await page.locator('#rating-error').innerText(), /choose a rating/);
  assert.match(await page.locator('#error-summary').innerText(), /fix 1 problem/);
  assert.deepEqual(requests, []);
  await context.close();
});

test('4. missing consent is caught', async () => {
  await resetBackend();
  const { page, context, requests } = await openPage();
  await fillValid(page, { consent: false });
  await submit(page);
  assert.match(await page.locator('#consent-error').innerText(), /confirm/);
  assert.deepEqual(requests, []);
  await context.close();
});

test('5. valid submission: success only after backend confirms; row written; no preflight', async () => {
  await resetBackend();
  const { page, context, requests, consoleErrors } = await openPage();
  await fillValid(page);
  await submit(page);
  await page.locator('#success-panel').waitFor();
  const ref = (await page.locator('#success-ref').innerText()).trim();
  assert.match(ref, /^R-\d{8}-[0-9A-F]{10}$/);
  assert.equal(await page.locator('#survey-form').isHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'success-title');
  assert.deepEqual(requests, ['POST'], 'exactly one simple POST, no OPTIONS preflight');

  const { headers, rows } = await sheet();
  assert.equal(rows.length, 1);
  const row = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]));
  assert.equal(row['Response ID'], ref);
  assert.equal(row.Name, 'Sara Ahmed');
  assert.equal(row.Email, 'sara@example.com');
  assert.equal(row.Rating, 4);
  assert.equal(row.Age, 32);
  assert.equal(row.Consent, 'Yes');
  assert.deepEqual(consoleErrors, []);
  await page.waitForTimeout(450); // let the fade-in finish
  await page.screenshot({ path: path.join(SHOTS, 'success.png'), fullPage: true });

  // Submit another response: form is reset and a new row is created.
  await page.getByRole('button', { name: /submit another/i }).click();
  assert.equal(await page.getByLabel('Full name').inputValue(), '');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-name');
  await fillValid(page, { name: 'Omar Ali', email: 'omar@example.com' });
  await submit(page);
  await page.locator('#success-panel').waitFor();
  const ref2 = (await page.locator('#success-ref').innerText()).trim();
  assert.notEqual(ref2, ref);
  assert.equal((await sheet()).rows.length, 2);
  await context.close();
});

test('6a. backend validation failure is mapped onto the fields (real server rule)', async () => {
  // Server allows one response per email per hour in this test; client can't know that,
  // so this exercises a real server-side rejection.
  await resetBackend({ MIN_FILL_MS: 0, MAX_PER_EMAIL_PER_HOUR: 1 });
  const { page, context } = await openPage();
  await fillValid(page);
  await submit(page);
  await page.locator('#success-panel').waitFor();
  await page.getByRole('button', { name: /submit another/i }).click();
  await fillValid(page);
  await submit(page);
  await page.locator('#submit-error').waitFor();
  assert.match(await page.locator('#submit-error').innerText(), /Too many responses/);
  assert.equal(await page.locator('#success-panel').isHidden(), true);
  assert.equal((await sheet()).rows.length, 1);
  await context.close();
});

test('6b. server VALIDATION_ERROR fields appear inline (stubbed response)', async () => {
  await resetBackend();
  const { page, context } = await openPage();
  await page.route('**/exec', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'x', fields: { email: 'Server rejected this address.' } } })
  }));
  await fillValid(page);
  await submit(page);
  await page.locator('#error-summary').waitFor();
  assert.match(await page.locator('#email-error').innerText(), /Server rejected/);
  assert.equal(await page.locator('#success-panel').isHidden(), true);
  await context.close();
});

test('7. network failure: clear error, answers kept, retry succeeds once', async () => {
  await resetBackend();
  const { page, context } = await openPage();
  await page.route('**/exec', (route) => route.abort('internetdisconnected'));
  await fillValid(page);
  await submit(page);
  await page.locator('#submit-error').waitFor();
  assert.match(await page.locator('#submit-error').innerText(), /Connection problem/);
  assert.equal(await page.getByLabel('Full name').inputValue(), 'Sara Ahmed', 'values preserved');
  assert.equal(await page.locator('#f-consent').isChecked(), true);
  assert.equal(await page.locator('#success-panel').isHidden(), true);
  assert.equal((await sheet()).rows.length, 0);
  await page.screenshot({ path: path.join(SHOTS, 'network-error.png'), fullPage: true });

  await page.unroute('**/exec');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('#success-panel').waitFor();
  assert.equal((await sheet()).rows.length, 1);
  await context.close();
});

test('7b. timeout after the server saved: retry returns the same ID, no duplicate row', async () => {
  await resetBackend({ MIN_FILL_MS: 0 }, 2500);
  const { page, context } = await openPage();
  await page.evaluate(() => { window.SURVEY_CONFIG.requestTimeoutMs = 800; });
  await fillValid(page);
  await submit(page);
  await page.locator('#submit-error').waitFor();
  assert.match(await page.locator('#submit-error').innerText(), /timed out/);
  await page.waitForTimeout(2200); // let the slow server finish writing
  assert.equal((await sheet()).rows.length, 1, 'server did write the first attempt');
  await dev('/__dev/config', { delayMs: 0 });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.locator('#success-panel').waitFor();
  const { rows, headers } = await sheet();
  assert.equal(rows.length, 1, 'retry did not create a duplicate');
  assert.equal((await page.locator('#success-ref').innerText()).trim(), rows[0][headers.indexOf('Response ID')]);
  await context.close();
});

test('7c. non-JSON reply (e.g. Google sign-in page) is never shown as success', async () => {
  await resetBackend();
  const { page, context } = await openPage();
  await page.route('**/exec', (route) => route.fulfill({ status: 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' }, body: '<html>Sign in</html>' }));
  await fillValid(page);
  await submit(page);
  await page.locator('#submit-error').waitFor();
  assert.match(await page.locator('#submit-error').innerText(), /couldn’t confirm/);
  assert.equal(await page.locator('#success-panel').isHidden(), true);
  await context.close();
});

test('8. repeated clicks and Enter while submitting send exactly one request', async () => {
  await resetBackend({ MIN_FILL_MS: 0 }, 1200);
  const { page, context, requests } = await openPage();
  await fillValid(page);
  const btn = page.locator('#submit-btn');
  await btn.click();
  assert.equal(await btn.isDisabled(), true);
  assert.match(await btn.innerText(), /Submitting/);
  assert.equal(await page.locator('#survey-form').getAttribute('aria-busy'), 'true');
  await btn.click({ force: true, noWaitAfter: true }).catch(() => {});
  await btn.click({ force: true, noWaitAfter: true }).catch(() => {});
  await page.getByLabel('Full name').press('Enter');
  await page.evaluate(() => document.getElementById('survey-form').requestSubmit());
  await page.locator('#success-panel').waitFor();
  assert.deepEqual(requests, ['POST']);
  assert.equal((await sheet()).rows.length, 1);
  await context.close();
});

test('9. oversized and whitespace-only input are rejected before sending', async () => {
  await resetBackend();
  const { page, context, requests } = await openPage();
  await fillValid(page, { name: '     ', feedback: 'z'.repeat(2050) });
  assert.match(await page.locator('#feedback-counter').innerText(), /2050 \/ 2000/);
  assert.ok(await page.locator('#feedback-counter.field__counter--over').count());
  await submit(page);
  assert.match(await page.locator('#name-error').innerText(), /required/);
  assert.match(await page.locator('#feedback-error').innerText(), /under 2000/);
  assert.deepEqual(requests, []);
  await context.close();
});

test('10. submissions faster than MIN_FILL_MS are refused by the server', async () => {
  await resetBackend({ MIN_FILL_MS: 60000 });
  const { page, context } = await openPage();
  await fillValid(page);
  await submit(page);
  await page.locator('#submit-error').waitFor();
  assert.match(await page.locator('#submit-error').innerText(), /take a moment/);
  assert.equal((await sheet()).rows.length, 0);
  await context.close();
});

test('11. ten browsers submitting at the same time → ten rows, unique IDs', async () => {
  await resetBackend({ MIN_FILL_MS: 0, MAX_SUBMISSIONS_PER_MINUTE: 0 });
  const sessions = await Promise.all(Array.from({ length: 10 }, () => openPage()));
  await Promise.all(sessions.map((s, i) => fillValid(s.page, { name: 'Parallel ' + i, email: `p${i}@example.com` })));
  await Promise.all(sessions.map((s) => submit(s.page)));
  const refs = await Promise.all(sessions.map(async (s) => {
    await s.page.locator('#success-panel').waitFor();
    return (await s.page.locator('#success-ref').innerText()).trim();
  }));
  assert.equal(new Set(refs).size, 10);
  const { rows } = await sheet();
  assert.equal(rows.length, 10);
  await Promise.all(sessions.map((s) => s.context.close()));
});

test('12. survey not connected (empty endpoint): explains, sends nothing', async () => {
  await resetBackend();
  const context = await browser.newContext();
  const page = await context.newPage();
  const sent = [];
  page.on('request', (r) => { if (r.url().includes('/exec')) sent.push(r.url()); });
  await page.route('**/js/form-config.js', async (route) => {
    const resp = await route.fetch();
    route.fulfill({ response: resp, body: (await resp.text()).replace(/endpoint:\s*'[^']*'/, "endpoint: ''") });
  });
  await page.goto(server.webUrl + '/');
  await fillValid(page);
  await submit(page);
  await page.locator('#submit-error').waitFor();
  assert.match(await page.locator('#submit-error').innerText(), /not connected yet/);
  assert.deepEqual(sent, []);
  await context.close();
});

test('13. keyboard only: complete and submit the survey without a mouse', async () => {
  await resetBackend();
  const { page, context } = await openPage();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip-link');
  await page.keyboard.press('Enter');                     // skip link → main
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-name');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
  assert.notEqual(outline, 'none', 'visible focus indicator');
  await page.keyboard.type('Keyboard User');
  await page.keyboard.press('Tab'); await page.keyboard.type('kb@example.com');
  await page.keyboard.press('Tab'); // phone (skip)
  await page.keyboard.press('Tab'); // age (skip)
  await page.keyboard.press('Tab'); // rating group → first radio
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-rating-1');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); // → 3
  assert.equal(await page.locator('#f-rating-3').isChecked(), true);
  await page.keyboard.press('Tab'); await page.keyboard.type('Keyboard navigation works nicely.');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-consent', 'honeypot is skipped');
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'submit-btn');
  await page.keyboard.press('Enter');
  await page.locator('#success-panel').waitFor();
  const { rows, headers } = await sheet();
  assert.equal(rows[0][headers.indexOf('Rating')], 3);
  await context.close();
});

test('14. mobile (375px): no horizontal scroll, full-width button, 16px inputs', async () => {
  await resetBackend();
  const { page, context } = await openPage({ context: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  const m = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    btnW: document.getElementById('submit-btn').getBoundingClientRect().width,
    formW: document.getElementById('survey-form').getBoundingClientRect().width,
    inputFont: getComputedStyle(document.getElementById('f-email')).fontSize,
    ratingH: document.querySelector('.rating__face').getBoundingClientRect().height
  }));
  assert.ok(m.scrollW <= m.innerW, `horizontal overflow: ${m.scrollW} > ${m.innerW}`);
  assert.ok(Math.abs(m.btnW - m.formW) < 2, 'submit button spans the form');
  assert.equal(m.inputFont, '16px');
  assert.ok(m.ratingH >= 44, 'rating targets ≥ 44px tall');
  await page.screenshot({ path: path.join(SHOTS, 'mobile.png'), fullPage: true });
  await submit(page);
  const m2 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.ok(m2, 'no overflow with errors shown');
  await page.screenshot({ path: path.join(SHOTS, 'mobile-errors.png'), fullPage: true });
  await context.close();

  const tablet = await openPage({ context: { viewport: { width: 768, height: 1024 } } });
  assert.ok(await tablet.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await tablet.context.close();
});

test('15. colour contrast of key text meets WCAG AA (≥4.5:1)', async () => {
  await resetBackend();
  const { page, context } = await openPage();
  await submit(page); // show error text too
  const results = await page.evaluate(() => {
    const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      while (el) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && !/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') return parse(c);
        el = el.parentElement;
      }
      return [255, 255, 255];
    };
    const sel = ['.intro__desc', '.field__label', '.field__help', '.required-note', '.field__error', '.btn--primary .btn__label', '.privacy__text', '.rating__lbl', '.eyebrow', '.site-footer p', '#error-summary li a'];
    return sel.map((s) => {
      const el = document.querySelector(s);
      if (!el) return { s, ratio: null };
      const L1 = lum(parse(getComputedStyle(el).color)); const L2 = lum(bgOf(el));
      return { s, ratio: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05) };
    });
  });
  for (const r of results) {
    assert.ok(r.ratio !== null, r.s + ' not found');
    assert.ok(r.ratio >= 4.5, `${r.s} contrast ${r.ratio.toFixed(2)}:1`);
  }
  await context.close();
});

test('16. reduced motion is respected', async () => {
  const { page, context } = await openPage({ context: { reducedMotion: 'reduce' } });
  const d = await page.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionDuration);
  assert.ok(parseFloat(d) < 0.01, 'transitions effectively disabled: ' + d);
  await context.close();
});
