/**
 * Survey backend — Google Apps Script Web App.
 *
 * Receives survey submissions from the public website, validates them on the
 * server, and appends one row per response to a Google Sheet.
 *
 * Setup (details in docs/SETUP.md):
 *   1. Paste this file into Extensions → Apps Script of your Google Sheet
 *      (replace the default Code.gs). Also replace appsscript.json.
 *   2. Optional: set CONFIG.SPREADSHEET_ID / CONFIG.SHEET_NAME below.
 *   3. Run setupSheet() once from the editor and authorize.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *
 * Functions ending in "_" are private: they cannot be run from the editor's
 * Run menu or called from the web.
 */

/* ======================================================================
   Configuration
   ====================================================================== */

var CONFIG = {
  // Leave empty when this script is attached to the spreadsheet (recommended:
  // created from the Sheet via Extensions → Apps Script). For a standalone
  // script, paste the ID from the sheet URL: docs.google.com/spreadsheets/d/<ID>/edit
  SPREADSHEET_ID: '',

  // Tab that receives responses. Created by setupSheet() if it doesn't exist.
  SHEET_NAME: 'Responses',

  // Timezone used for the Response ID date and applied to the spreadsheet by
  // setupSheet(). Timestamps are written as real date-times and displayed in
  // the spreadsheet's timezone (File → Settings). Use an IANA name.
  TIMEZONE: 'Africa/Cairo',

  // Abuse limits. Set any number to 0 to disable that check.
  MAX_BODY_CHARS: 20000,          // reject request bodies larger than this
  MIN_FILL_MS: 3000,              // reject forms submitted faster than this after page load
  MAX_SUBMISSIONS_PER_MINUTE: 30, // across ALL users (Apps Script cannot see IP addresses)
  MAX_PER_EMAIL_PER_HOUR: 5,      // per email address

  // A retry carrying the same submissionId within this window returns the
  // original result instead of writing a second row. Max 21600 (6 h).
  IDEMPOTENCY_SECONDS: 21600,

  LOCK_WAIT_MS: 10000
};

/**
 * Server-side field rules. MUST mirror js/form-config.js (ids, types, limits).
 * `header` is the column name in the sheet. Column order follows this list.
 * `npm test` checks that this list matches the frontend config.
 */
var FIELDS = [
  { id: 'name',     header: 'Name',     type: 'text',     required: true,  minLength: 2,  maxLength: 100 },
  { id: 'email',    header: 'Email',    type: 'email',    required: true,                 maxLength: 254 },
  { id: 'phone',    header: 'Phone',    type: 'tel',      required: false, minLength: 6,  maxLength: 25 },
  { id: 'age',      header: 'Age',      type: 'number',   required: false, min: 13,       max: 120 },
  { id: 'rating',   header: 'Rating',   type: 'rating',   required: true,  min: 1,        max: 5 },
  { id: 'feedback', header: 'Feedback', type: 'textarea', required: true,  minLength: 10, maxLength: 2000 },
  { id: 'consent',  header: 'Consent',  type: 'consent',  required: true }

  // Examples matching the commented-out questions in form-config.js:
  // ,{ id: 'channel', header: 'Channel', type: 'select', required: false,
  //    options: [{ value: 'search' }, { value: 'social' }, { value: 'friend' }, { value: 'other' }] }
  // ,{ id: 'topics',  header: 'Topics',  type: 'checkboxes', required: false,
  //    options: [{ value: 'speed' }, { value: 'quality' }, { value: 'support' }, { value: 'price' }] }
];

var SYSTEM_HEADERS = ['Timestamp', 'Response ID'];
var TIMESTAMP_FORMAT = 'yyyy-mm-dd hh:mm:ss';

/* ======================================================================
   Web entry points
   ====================================================================== */

/** Health check: open the /exec URL in a browser to confirm the deployment works. */
function doGet() {
  return json_({ ok: true, service: 'survey-backend', message: 'Survey endpoint is running. Submit responses with POST.' });
}

/** Receives a submission. Always answers with JSON; never leaks internals. */
function doPost(e) {
  var result;
  try {
    result = handleSubmission_(e);
  } catch (err) {
    // Full details go to the private execution log (Apps Script → Executions),
    // never to the public response.
    console.error('Unhandled error in doPost: ' + (err && err.stack ? err.stack : err));
    result = fail_('SERVER_ERROR', 'Something went wrong on our side. Please try again in a moment.');
  }
  return json_(result);
}

/* ======================================================================
   Spreadsheet setup (run once from the editor)
   ====================================================================== */

/**
 * Creates the responses tab and header row if needed, adds any missing
 * headers to the right, formats the timestamp column, and freezes the header.
 * Never deletes, reorders, or overwrites existing data. Safe to run again.
 */
function setupSheet() {
  var ss = getSpreadsheet_();
  if (CONFIG.TIMEZONE) ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);
  var info = ensureSheet_(ss);
  var msg = 'Sheet "' + info.sheet.getName() + '" is ready. ' +
    (info.created ? 'Created the tab. ' : '') +
    (info.added.length ? 'Added headers: ' + info.added.join(', ') + '. ' : 'Headers already present. ') +
    'Existing data rows: ' + Math.max(0, info.sheet.getLastRow() - 1) + '.';
  console.log(msg);
  return msg;
}

/* ======================================================================
   Submission handling
   ====================================================================== */

function handleSubmission_(e) {
  // ---- 1. Parse the request -------------------------------------------
  var body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  if (!body) return fail_('BAD_REQUEST', 'The request was empty.');
  if (CONFIG.MAX_BODY_CHARS && body.length > CONFIG.MAX_BODY_CHARS) {
    return fail_('PAYLOAD_TOO_LARGE', 'Your response is too long. Please shorten it and try again.');
  }

  var req;
  try { req = JSON.parse(body); } catch (err) { return fail_('BAD_REQUEST', 'The request could not be read.'); }
  if (!isPlainObject_(req) || !isPlainObject_(req.answers)) {
    return fail_('BAD_REQUEST', 'The request is missing the survey answers.');
  }

  var submissionId = req.submissionId;
  if (typeof submissionId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(submissionId)) {
    return fail_('BAD_REQUEST', 'The request is missing a valid submission ID.');
  }

  var meta = isPlainObject_(req.meta) ? req.meta : {};

  // ---- 2. Basic bot checks --------------------------------------------
  // Honeypot filled in: pretend success so the bot learns nothing, but write nothing.
  if (typeof meta.hp === 'string' && meta.hp.trim() !== '') {
    console.warn('Honeypot triggered; submission dropped.');
    return { ok: true, responseId: makeResponseId_(new Date()), timestamp: new Date().toISOString() };
  }
  if (CONFIG.MIN_FILL_MS) {
    var elapsed = meta.elapsedMs;
    if (typeof elapsed !== 'number' || !isFinite(elapsed) || elapsed < CONFIG.MIN_FILL_MS) {
      return fail_('TOO_FAST', 'Please take a moment to review your answers, then submit again.');
    }
  }

  // ---- 3. Validate every field (unknown keys are ignored, never stored) -
  var v = validateAnswers_(req.answers);
  if (!v.valid) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Please check the highlighted fields.', fields: v.errors } };
  }

  var cache = CacheService.getScriptCache();
  var idemKey = 'sub:' + submissionId;

  // Fast path: a retry of a submission we already saved.
  var prior = cache.get(idemKey);
  if (prior) return withDuplicateFlag_(prior);

  // ---- 4. Write under a lock -------------------------------------------
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) {
    return fail_('BUSY', 'The server is busy. Please try again in a few seconds.');
  }
  try {
    // Re-check inside the lock: two identical retries may have raced here.
    prior = cache.get(idemKey);
    if (prior) return withDuplicateFlag_(prior);

    var limited = checkRateLimits_(cache, v.values.email);
    if (limited) return limited;

    var ss = getSpreadsheet_();
    var sheet = ensureSheet_(ss).sheet;
    var now = new Date();
    var responseId = makeResponseId_(now);

    var row = buildRow_(sheet, now, responseId, v.values);
    sheet.appendRow(row);
    SpreadsheetApp.flush();

    var result = { ok: true, responseId: responseId, timestamp: now.toISOString() };
    if (CONFIG.IDEMPOTENCY_SECONDS) {
      cache.put(idemKey, JSON.stringify(result), Math.min(CONFIG.IDEMPOTENCY_SECONDS, 21600));
    }
    recordRateLimitHit_(cache, v.values.email);
    return result;
  } finally {
    lock.releaseLock();
  }
}

/* ======================================================================
   Validation (independent of the browser — assume requests are forged)
   ====================================================================== */

var EMAIL_RE_ = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;
var PHONE_RE_ = /^\+?[0-9\s().\-]+$/;
var CONTROL_RE_ = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
var DEFAULT_MAX_TEXT_ = 500;

function validateAnswers_(answers) {
  var values = {};
  var errors = {};
  for (var i = 0; i < FIELDS.length; i++) {
    var f = FIELDS[i];
    var raw = Object.prototype.hasOwnProperty.call(answers, f.id) ? answers[f.id] : undefined;
    var r = validateField_(f, raw);
    values[f.id] = r.value;
    if (r.error) errors[f.id] = r.error;
  }
  return { values: values, errors: errors, valid: Object.keys(errors).length === 0 };
}

function cleanString_(value, multiline) {
  if (value === null || value === undefined) return '';
  // Only accept primitives; objects/arrays become '' and fail "required".
  if (typeof value === 'object') return '';
  var s = String(value);
  if (typeof s.normalize === 'function') s = s.normalize('NFC');
  s = s.replace(/\r\n?/g, '\n').replace(CONTROL_RE_, '');
  if (!multiline) s = s.replace(/\s+/g, ' ');
  return s.trim();
}

function charLength_(s) { return Array.from(s).length; }

function validateField_(f, raw) {
  switch (f.type) {
    case 'text':
    case 'email':
    case 'tel':
    case 'textarea': {
      var s = cleanString_(raw, f.type === 'textarea');
      if (s === '') return { value: '', error: f.required ? 'This field is required.' : null };
      var max = f.maxLength || DEFAULT_MAX_TEXT_;
      var len = charLength_(s);
      if (f.minLength && len < f.minLength) return { value: '', error: 'Please enter at least ' + f.minLength + ' characters.' };
      if (len > max) return { value: '', error: 'Please keep this under ' + max + ' characters.' };
      if (f.type === 'email') {
        s = s.toLowerCase();
        if (!EMAIL_RE_.test(s)) return { value: '', error: 'Please enter a valid email address.' };
      }
      if (f.type === 'tel') {
        var digits = s.replace(/\D/g, '');
        if (!PHONE_RE_.test(s) || digits.length < 6 || digits.length > 15) {
          return { value: '', error: 'Please enter a valid phone number.' };
        }
      }
      return { value: s, error: null };
    }

    case 'number':
    case 'rating': {
      var t = typeof raw === 'number' ? (isFinite(raw) ? String(raw) : 'x') : cleanString_(raw, false);
      if (t === '') return { value: '', error: f.required ? (f.type === 'rating' ? 'Please choose a rating.' : 'This field is required.') : null };
      if (!/^-?\d+$/.test(t)) return { value: '', error: f.type === 'rating' ? 'Please choose a rating.' : 'Please enter a whole number.' };
      var n = parseInt(t, 10);
      var lo = typeof f.min === 'number' ? f.min : -Infinity;
      var hi = typeof f.max === 'number' ? f.max : Infinity;
      if (n < lo || n > hi) {
        return { value: '', error: f.type === 'rating' ? 'Please choose a rating from ' + lo + ' to ' + hi + '.' : 'Please enter a number between ' + lo + ' and ' + hi + '.' };
      }
      return { value: n, error: null };
    }

    case 'select':
    case 'radio': {
      var c = cleanString_(raw, false);
      if (c === '') return { value: '', error: f.required ? 'Please choose an option.' : null };
      if (optionValues_(f).indexOf(c) === -1) return { value: '', error: 'Please choose one of the listed options.' };
      return { value: c, error: null };
    }

    case 'checkboxes': {
      var arr = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
      if (arr.length > 50) return { value: [], error: 'Please choose from the listed options.' };
      var allowed = optionValues_(f);
      var seen = {};
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var item = cleanString_(arr[i], false);
        if (allowed.indexOf(item) === -1) return { value: [], error: 'Please choose from the listed options.' };
        if (!seen[item]) { seen[item] = true; out.push(item); }
      }
      if (!out.length) return { value: [], error: f.required ? 'Please choose an option.' : null };
      return { value: out, error: null };
    }

    case 'consent': {
      var yes = raw === true || raw === 'true' || raw === 'on' || raw === 'yes';
      if (!yes && f.required) return { value: false, error: 'Consent is required to submit a response.' };
      return { value: yes, error: null };
    }

    default:
      throw new Error('Unsupported field type in FIELDS: ' + f.type);
  }
}

function optionValues_(f) {
  return (f.options || []).map(function (o) { return String(o.value); });
}

/* ======================================================================
   Sheet helpers
   ====================================================================== */

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('No spreadsheet: set CONFIG.SPREADSHEET_ID or create the script from the Sheet (Extensions → Apps Script).');
  return active;
}

function expectedHeaders_() {
  return SYSTEM_HEADERS.concat(FIELDS.map(function (f) { return f.header; }));
}

/**
 * Makes sure the responses tab exists and has every expected header.
 * Only ever ADDS: creates the tab, writes headers into an empty first row,
 * or appends missing headers after the last used column.
 * Refuses (throws) if row 1 holds unrelated content, rather than mixing data.
 */
function ensureSheet_(ss) {
  var created = false;
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    created = true;
  }

  var expected = expectedHeaders_();
  var lastCol = sheet.getLastColumn();
  var current = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  var rowOneEmpty = current.every(function (h) { return h === ''; });

  var added = [];
  if (rowOneEmpty) {
    if (sheet.getLastRow() > 1) {
      throw new Error('Sheet "' + CONFIG.SHEET_NAME + '" has data but no header row. Add headers manually or use an empty tab.');
    }
    sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
    added = expected.slice();
    lastCol = expected.length;
  } else {
    var known = expected.filter(function (h) { return current.indexOf(h) !== -1; });
    if (known.length === 0) {
      throw new Error('Row 1 of "' + CONFIG.SHEET_NAME + '" contains unrelated headers. Use an empty tab or a different SHEET_NAME.');
    }
    var missing = expected.filter(function (h) { return current.indexOf(h) === -1; });
    if (missing.length) {
      sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
      added = missing;
      lastCol += missing.length;
    }
  }

  if (added.length) {
    sheet.getRange(1, 1, 1, lastCol).setFontWeight('bold');
    sheet.setFrozenRows(1);
    var tsCol = headerIndex_(sheet, 'Timestamp');
    if (tsCol && sheet.getMaxRows() > 1) {
      sheet.getRange(2, tsCol, sheet.getMaxRows() - 1, 1).setNumberFormat(TIMESTAMP_FORMAT);
    }
  }
  return { sheet: sheet, created: created, added: added };
}

function headerIndex_(sheet, name) {
  var lastCol = sheet.getLastColumn();
  if (!lastCol) return 0;
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < headers.length; i++) if (String(headers[i]).trim() === name) return i + 1;
  return 0;
}

/** Builds a row by header NAME, so columns reordered by hand still line up. */
function buildRow_(sheet, now, responseId, values) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var byHeader = { 'Timestamp': now, 'Response ID': responseId };
  FIELDS.forEach(function (f) { byHeader[f.header] = toCell_(f, values[f.id]); });
  return headers.map(function (h) { return Object.prototype.hasOwnProperty.call(byHeader, h) ? byHeader[h] : ''; });
}

function toCell_(f, value) {
  if (f.type === 'consent') return value ? 'Yes' : 'No';
  if (f.type === 'checkboxes') return safeText_((value || []).join(', '));
  if (typeof value === 'number') return value;
  return safeText_(value === undefined || value === null ? '' : String(value));
}

/**
 * Prevents spreadsheet formula injection: text starting with = + - @ (or a
 * tab/CR) would otherwise be evaluated as a formula when written. A leading
 * apostrophe makes Sheets store it as plain text (the apostrophe isn't shown).
 */
function safeText_(s) {
  if (s === '') return s;
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function makeResponseId_(now) {
  var tz = CONFIG.TIMEZONE || Session.getScriptTimeZone();
  var day = Utilities.formatDate(now, tz, 'yyyyMMdd');
  var rand = Utilities.getUuid().replace(/-/g, '').slice(0, 10).toUpperCase();
  return 'R-' + day + '-' + rand;
}

/* ======================================================================
   Rate limiting (best effort, via CacheService; called inside the lock)
   ====================================================================== */

function minuteKey_() { return 'rl:min:' + Math.floor(Date.now() / 60000); }
function hourKey_() { return Math.floor(Date.now() / 3600000); }

function emailKey_(email) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email), Utilities.Charset.UTF_8);
  var hex = digest.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  return 'rl:email:' + hex.slice(0, 32) + ':' + hourKey_();
}

function checkRateLimits_(cache, email) {
  if (CONFIG.MAX_SUBMISSIONS_PER_MINUTE) {
    var n = parseInt(cache.get(minuteKey_()) || '0', 10);
    if (n >= CONFIG.MAX_SUBMISSIONS_PER_MINUTE) {
      return fail_('RATE_LIMITED', 'We are receiving a lot of responses right now. Please try again in a minute.');
    }
  }
  if (CONFIG.MAX_PER_EMAIL_PER_HOUR && email) {
    var m = parseInt(cache.get(emailKey_(email)) || '0', 10);
    if (m >= CONFIG.MAX_PER_EMAIL_PER_HOUR) {
      return fail_('RATE_LIMITED', 'We have already received several responses from this email address. Please try again later.');
    }
  }
  return null;
}

function recordRateLimitHit_(cache, email) {
  if (CONFIG.MAX_SUBMISSIONS_PER_MINUTE) {
    var k = minuteKey_();
    cache.put(k, String(parseInt(cache.get(k) || '0', 10) + 1), 120);
  }
  if (CONFIG.MAX_PER_EMAIL_PER_HOUR && email) {
    var ek = emailKey_(email);
    cache.put(ek, String(parseInt(cache.get(ek) || '0', 10) + 1), 3700);
  }
}

/* ======================================================================
   Small utilities
   ====================================================================== */

function isPlainObject_(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function fail_(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function withDuplicateFlag_(cachedJson) {
  var r = JSON.parse(cachedJson);
  r.duplicate = true;
  return r;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
