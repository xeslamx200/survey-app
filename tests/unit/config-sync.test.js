'use strict';
/**
 * Keeps the frontend (js/form-config.js + js/validation.js) and the backend
 * (apps-script/Code.gs FIELDS + validator) in agreement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../js/validation.js');
const CONFIG = require('../../js/form-config.js');
const { createBackend } = require('../helpers/gas-harness');

const front = V.getFields(CONFIG);
const ctx = createBackend().ctx;
const back = ctx.FIELDS;

const RULE_KEYS = ['type', 'required', 'minLength', 'maxLength', 'min', 'max'];

test('frontend and backend define the same fields in the same order', () => {
  assert.deepEqual(front.map((f) => f.id), Array.from(back, (f) => f.id));
});

test('every field has matching rules on both sides', () => {
  back.forEach((b) => {
    const f = front.find((x) => x.id === b.id);
    const norm = (v) => (v === undefined || v === false ? null : v);
    RULE_KEYS.forEach((k) => {
      assert.equal(norm(f[k]), norm(b[k]), `${b.id}.${k} differs (frontend ${f[k]} vs backend ${b[k]})`);
    });
    if (f.options || b.options) {
      assert.deepEqual((f.options || []).map((o) => String(o.value)), Array.from(b.options || [], (o) => String(o.value)), b.id + ' options differ');
    }
    assert.ok(b.header && typeof b.header === 'string', b.id + ' needs a sheet header');
  });
});

test('backend headers are unique and do not clash with system columns', () => {
  const headers = Array.from(back, (f) => f.header);
  assert.equal(new Set(headers).size, headers.length);
  ['Timestamp', 'Response ID'].forEach((h) => assert.ok(!headers.includes(h)));
});

// Feed the same inputs to both validators: they must agree on accept/reject
// and on the normalized value.
const BATTERY = {
  text: ['', ' ', 'A', 'Al', '  Sara  Ahmed  ', 'x'.repeat(100), 'x'.repeat(101), 'Sa\u0000ra', '😀😀', 42, null, true],
  email: ['', 'a@b.co', 'A@B.CO', 'bad', 'a@b', 'a @b.co', 'x@y.com.eg', '=x@y.com', 'a@b.c'],
  tel: ['', '+20 100 123 4567', '12345', '123456', '(02) 1234-5678', 'call me', '+'.padEnd(26, '1')],
  number: ['', '13', '12', '120', '121', '30.5', 'abc', 32, -5, '1e2'],
  rating: ['', '1', '5', '0', '6', '4.5', 3, 'x'],
  textarea: ['', 'short', 'long enough text', 'line one here\r\nline two', 'y'.repeat(2000), 'y'.repeat(2001)],
  consent: [true, false, 'true', 'on', 'yes', undefined, 'no', 1]
};

test('client and server validators agree on a battery of inputs', () => {
  back.forEach((bf) => {
    const ff = front.find((x) => x.id === bf.id);
    (BATTERY[bf.type] || []).forEach((input) => {
      const c = V.validateField(ff, input);
      const s = ctx.validateField_(bf, input);
      const label = `${bf.id} ← ${JSON.stringify(input)}`;
      assert.equal(!c.error, !s.error, `${label}: client ${c.error ? 'rejects' : 'accepts'}, server ${s.error ? 'rejects' : 'accepts'}`);
      if (!c.error) assert.deepEqual(s.value, c.value, label + ' normalized value differs');
    });
  });
});
