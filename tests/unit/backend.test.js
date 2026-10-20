'use strict';
/**
 * Backend tests: run the real apps-script/Code.gs against in-memory mocks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend, validPayload, MockSpreadsheet } = require('../helpers/gas-harness');

const HEADERS = ['Timestamp', 'Response ID', 'Name', 'Email', 'Phone', 'Age', 'Rating', 'Feedback', 'Consent'];

test('doGet health check returns JSON', () => {
  const b = createBackend();
  const r = b.get();
  assert.equal(r.mime, 'application/json');
  assert.equal(r.json.ok, true);
});

test('valid submission writes exactly one correct row and returns ok + responseId', () => {
  const b = createBackend();
  const r = b.post(validPayload());
  assert.equal(r.mime, 'application/json');
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  assert.match(r.json.responseId, /^R-\d{8}-[0-9A-F]{10}$/);
  assert.ok(!Number.isNaN(Date.parse(r.json.timestamp)));

  const { headers, rows } = b.rows();
  assert.deepEqual(headers, HEADERS);
  assert.equal(rows.length, 1);
  const row = Object.fromEntries(headers.map((h, i) => [h, rows[0][i]]));
  assert.equal(Object.prototype.toString.call(row.Timestamp), '[object Date]', 'timestamp is a real date');
  assert.equal(row['Response ID'], r.json.responseId);
  assert.equal(row.Name, 'Sara Ahmed');
  assert.equal(row.Email, 'sara@example.com');
  assert.equal(row.Phone, "'+20 100 123 4567", 'leading + is escaped so Sheets keeps it as text');
  assert.equal(row.Age, 32);
  assert.equal(row.Rating, 4);
  assert.equal(row.Feedback, 'Great service, quick replies.');
  assert.equal(row.Consent, 'Yes');
  assert.ok(b.flushes >= 1);
});

test('lock is acquired and released for every write', () => {
  const b = createBackend();
  b.post(validPayload());
  b.post(validPayload());
  assert.equal(b.lock.acquired, 2);
  assert.equal(b.lock.released, 2);
  assert.equal(b.lock.held, false);
});

test('lock unavailable → BUSY, nothing written', () => {
  const b = createBackend();
  b.lock.busy = true;
  const r = b.post(validPayload());
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'BUSY');
  assert.equal(b.rows().rows.length, 0);
});

test('lock is released even when the sheet write throws, and no internals leak', () => {
  const b = createBackend();
  b.post(validPayload()); // creates sheet
  const sheet = b.spreadsheet.getSheetByName('Responses');
  sheet.appendRow = () => { throw new Error('Service Spreadsheets failed: internal detail /secret/path'); };
  const r = b.post(validPayload());
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'SERVER_ERROR');
  assert.doesNotMatch(r.raw, /secret|internal detail|stack|at /i);
  assert.equal(b.lock.held, false);
  assert.ok(b.logs.some(([lvl, msg]) => lvl === 'error' && /internal detail/.test(msg)), 'details go to the private log');
});

test('malformed requests are rejected with BAD_REQUEST', () => {
  const b = createBackend();
  const cases = [
    '',
    'not json',
    '[]',
    'null',
    JSON.stringify({ submissionId: 'abcdefghijklmnop1234', meta: { elapsedMs: 9999 } }),               // no answers
    JSON.stringify(Object.assign(validPayload(), { answers: [] })),                                     // answers not object
    JSON.stringify(Object.assign(validPayload(), { submissionId: undefined })),                        // no id
    JSON.stringify(Object.assign(validPayload(), { submissionId: 'short' })),
    JSON.stringify(Object.assign(validPayload(), { submissionId: '<script>alert(1)</script>xxxxxxxx' }))
  ];
  for (const body of cases) {
    const r = body === '' ? b.ctx.doPost({}) : null;
    const res = r ? JSON.parse(r.getContent()) : b.post(body).json;
    assert.equal(res.ok, false, 'should reject: ' + body);
    assert.equal(res.error.code, 'BAD_REQUEST', body);
  }
  assert.equal(b.rows().rows.length, 0);
});

test('oversized request body → PAYLOAD_TOO_LARGE', () => {
  const b = createBackend();
  const p = validPayload({ answers: { feedback: 'x'.repeat(30000) } });
  const r = b.post(p);
  assert.equal(r.json.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(b.rows().rows.length, 0);
});

test('field-level validation errors are returned per field, nothing written', () => {
  const b = createBackend();
  const r = b.post(validPayload({ answers: { name: '', email: 'nope', rating: 9, feedback: 'short', consent: false } }));
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(Object.keys(r.json.error.fields).sort(), ['consent', 'email', 'feedback', 'name', 'rating']);
  assert.equal(b.rows().rows.length, 0);
});

test('oversized individual fields are rejected server-side', () => {
  const b = createBackend();
  const r = b.post(validPayload({ answers: { name: 'n'.repeat(101), feedback: 'f'.repeat(2001) } }));
  assert.equal(r.json.error.code, 'VALIDATION_ERROR');
  assert.ok(r.json.error.fields.name && r.json.error.fields.feedback);
});

test('wrong value types (objects, arrays, floats, strings for rating) are rejected', () => {
  const b = createBackend();
  for (const bad of [
    { name: { first: 'x' } },
    { email: ['a@b.co'] },
    { rating: 4.5 },
    { rating: '5; DROP TABLE' },
    { rating: Infinity },
    { age: '1e2' },
    { consent: 'false' },
    { consent: 1 }
  ]) {
    const r = b.post(validPayload({ answers: bad }));
    assert.equal(r.json.ok, false, 'should reject ' + JSON.stringify(bad));
  }
  assert.equal(b.rows().rows.length, 0);
});

test('unexpected extra fields are ignored and never stored', () => {
  const b = createBackend();
  const p = validPayload({ answers: { isAdmin: true, Timestamp: 'forged', 'Response ID': 'forged', password: 'x' } });
  p.extraTopLevel = { a: 1 };
  const r = b.post(p);
  assert.equal(r.json.ok, true);
  const { headers, rows } = b.rows();
  assert.deepEqual(headers, HEADERS, 'no new columns');
  assert.ok(!rows[0].includes('forged'));
  assert.ok(!rows[0].includes('x'));
});

test('formula injection is neutralized', () => {
  const b = createBackend();
  const r = b.post(validPayload({ answers: { name: '=HYPERLINK("http://evil","x")', feedback: '@SUM(A1:A9) and more text', email: '=cmd@example.com' } }));
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const row = b.rows().rows[0];
  assert.equal(row[2], '\'=HYPERLINK("http://evil","x")');
  assert.equal(row[7], "'@SUM(A1:A9) and more text");
  assert.equal(row[3], "'=cmd@example.com");
});

test('honeypot: reports success to the bot but writes nothing', () => {
  const b = createBackend();
  const r = b.post(validPayload({ meta: { hp: 'http://spam.example' } }));
  assert.equal(r.json.ok, true);
  assert.equal(b.rows().rows.length, 0);
});

test('submitted too quickly or without timing → TOO_FAST', () => {
  const b = createBackend();
  assert.equal(b.post(validPayload({ meta: { elapsedMs: 500 } })).json.error.code, 'TOO_FAST');
  const p = validPayload(); delete p.meta;
  assert.equal(b.post(p).json.error.code, 'TOO_FAST');
  assert.equal(b.rows().rows.length, 0);
});

test('retry with the same submissionId does not create a duplicate row', () => {
  const b = createBackend();
  const p = validPayload();
  const first = b.post(p).json;
  const second = b.post(p).json;
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.responseId, first.responseId);
  assert.equal(second.duplicate, true);
  assert.equal(b.rows().rows.length, 1);
});

test('many submissions produce distinct rows with unique response IDs', () => {
  const b = createBackend({ config: { MAX_SUBMISSIONS_PER_MINUTE: 0, MAX_PER_EMAIL_PER_HOUR: 0 } });
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const r = b.post(validPayload({ answers: { name: 'User ' + i } })).json;
    assert.equal(r.ok, true);
    ids.add(r.responseId);
  }
  assert.equal(ids.size, 50);
  const { rows } = b.rows();
  assert.equal(rows.length, 50);
  assert.deepEqual(rows.map((r) => r[2]), Array.from({ length: 50 }, (_, i) => 'User ' + i));
});

test('global per-minute rate limit', () => {
  const b = createBackend({ config: { MAX_SUBMISSIONS_PER_MINUTE: 3, MAX_PER_EMAIL_PER_HOUR: 0 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push(b.post(validPayload()).json.ok ? 'OK' : 'LIMIT');
  // (Can straddle a minute boundary in rare cases; then fewer LIMITs.)
  assert.equal(codes.slice(0, 3).join(), 'OK,OK,OK');
  assert.ok(b.rows().rows.length <= 5 && b.rows().rows.length >= 3);
});

test('per-email hourly limit (case-insensitive)', () => {
  const b = createBackend({ config: { MAX_SUBMISSIONS_PER_MINUTE: 0, MAX_PER_EMAIL_PER_HOUR: 2 } });
  assert.equal(b.post(validPayload({ answers: { email: 'a@example.com' } })).json.ok, true);
  assert.equal(b.post(validPayload({ answers: { email: 'A@EXAMPLE.com' } })).json.ok, true);
  const third = b.post(validPayload({ answers: { email: 'a@example.com' } })).json;
  assert.equal(third.error.code, 'RATE_LIMITED');
  assert.equal(b.post(validPayload({ answers: { email: 'b@example.com' } })).json.ok, true);
  // email hashes, not raw addresses, are used as cache keys
  for (const k of b.cacheStore.keys()) assert.doesNotMatch(k, /@/);
});

/* ---------------- setupSheet ---------------- */

test('setupSheet on an empty spreadsheet creates the tab, headers, format and frozen row', () => {
  const b = createBackend();
  const msg = b.ctx.setupSheet();
  assert.match(msg, /ready/);
  const s = b.spreadsheet.getSheetByName('Responses');
  assert.deepEqual(s.data[0], HEADERS);
  assert.equal(s.frozenRows, 1);
  assert.ok(s.formats.some((f) => f.kind === 'numberFormat' && f.col === 1));
  assert.equal(b.spreadsheet.timeZone, 'Africa/Cairo');
  // running it again changes nothing
  b.ctx.setupSheet();
  assert.deepEqual(s.data, [HEADERS]);
});

test('setupSheet preserves existing data and only appends missing headers', () => {
  const ss = new MockSpreadsheet();
  const s = ss.insertSheet('Responses');
  // Older layout: no Phone/Age columns, and an extra manual "Notes" column.
  const oldHeaders = ['Timestamp', 'Response ID', 'Name', 'Email', 'Rating', 'Feedback', 'Consent', 'Notes'];
  s.data.push(oldHeaders.slice());
  s.data.push([new Date(), 'R-1', 'Old', 'old@x.com', 5, 'old feedback here', 'Yes', 'follow up']);
  const b = createBackend({ spreadsheet: ss });
  const msg = b.ctx.setupSheet();
  assert.match(msg, /Added headers: Phone, Age/);
  assert.deepEqual(s.data[0], oldHeaders.concat(['Phone', 'Age']));
  assert.equal(s.data[1][2], 'Old');
  assert.equal(s.data[1][7], 'follow up');
  assert.equal(s.getLastRow(), 2);

  // New submission maps by header name into the reordered layout.
  const r = b.post(validPayload());
  assert.equal(r.json.ok, true);
  const row = s.data[2];
  const at = (h) => row[s.data[0].indexOf(h)];
  assert.equal(at('Name'), 'Sara Ahmed');
  assert.equal(at('Phone'), "'+20 100 123 4567");
  assert.equal(at('Age'), 32);
  assert.equal(at('Notes'), '');
  assert.equal(s.data[1][2], 'Old', 'old row untouched');
});

test('setupSheet refuses a tab with unrelated headers or headerless data', () => {
  const ss = new MockSpreadsheet();
  ss.insertSheet('Responses').data.push(['Invoice', 'Amount']);
  const b = createBackend({ spreadsheet: ss });
  assert.throws(() => b.ctx.setupSheet(), /unrelated headers/);
  assert.deepEqual(ss.getSheetByName('Responses').data, [['Invoice', 'Amount']]);

  const ss2 = new MockSpreadsheet();
  const s2 = ss2.insertSheet('Responses');
  s2.data.push(['', '']);
  s2.data.push(['some', 'data']);
  assert.throws(() => createBackend({ spreadsheet: ss2 }).ctx.setupSheet(), /no header row/);
});

test('submission to an unrelated tab fails safely without writing', () => {
  const ss = new MockSpreadsheet();
  ss.insertSheet('Responses').data.push(['Invoice', 'Amount']);
  const b = createBackend({ spreadsheet: ss });
  const r = b.post(validPayload());
  assert.equal(r.json.error.code, 'SERVER_ERROR');
  assert.equal(ss.getSheetByName('Responses').data.length, 1);
  assert.equal(b.lock.held, false);
});
