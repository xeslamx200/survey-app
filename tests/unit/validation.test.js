'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../../js/validation.js');
const CONFIG = require('../../js/form-config.js');

const FIELDS = V.getFields(CONFIG);
const F = Object.fromEntries(FIELDS.map((f) => [f.id, f]));

const valid = () => ({
  name: '  Sara   Ahmed ',
  email: ' Sara@Example.COM ',
  phone: '',
  age: '',
  rating: '4',
  feedback: 'Really helpful team overall.',
  consent: true
});

test('config defines the required sample fields', () => {
  assert.deepEqual(FIELDS.map((f) => f.id), ['name', 'email', 'phone', 'age', 'rating', 'feedback', 'consent']);
  const ids = new Set();
  FIELDS.forEach((f) => { assert.ok(!ids.has(f.id), 'duplicate id ' + f.id); ids.add(f.id); });
});

test('empty form: every required field reports an error, optional ones do not', () => {
  const r = V.validateAll(FIELDS, {});
  assert.equal(r.valid, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['consent', 'email', 'feedback', 'name', 'rating']);
});

test('valid form passes and values are trimmed/normalized', () => {
  const r = V.validateAll(FIELDS, valid());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.values.name, 'Sara Ahmed');
  assert.equal(r.values.email, 'sara@example.com');
  assert.equal(r.values.rating, 4);
  assert.equal(r.values.consent, true);
  assert.equal(r.values.age, '');
});

test('invalid emails are rejected', () => {
  for (const bad of ['plainaddress', 'a@b', 'a@b.', '@example.com', 'a b@example.com', 'a@@example.com', 'a@example.c', 'a@.com']) {
    assert.ok(V.validateField(F.email, bad).error, 'should reject ' + bad);
  }
  for (const good of ['a@b.co', 'first.last+tag@sub.example.org', 'x@example.com.eg']) {
    assert.equal(V.validateField(F.email, good).error, null, 'should accept ' + good);
  }
});

test('rating: missing, out-of-range and non-integer values are rejected', () => {
  assert.equal(V.validateField(F.rating, '').error, 'Please choose a rating.');
  for (const bad of ['0', '6', '-1', '4.5', 'abc']) assert.ok(V.validateField(F.rating, bad).error, bad);
  for (const ok of ['1', '3', '5', 5]) assert.equal(V.validateField(F.rating, ok).error, null);
});

test('consent is required', () => {
  assert.ok(V.validateField(F.consent, false).error);
  assert.ok(V.validateField(F.consent, undefined).error);
  assert.equal(V.validateField(F.consent, true).error, null);
});

test('length limits: too short and too long are rejected, counted in characters', () => {
  assert.ok(V.validateField(F.name, 'A').error);
  assert.ok(V.validateField(F.name, 'x'.repeat(101)).error);
  assert.equal(V.validateField(F.name, 'x'.repeat(100)).error, null);
  assert.ok(V.validateField(F.feedback, 'short').error);
  assert.ok(V.validateField(F.feedback, 'y'.repeat(2001)).error);
  // 100 emoji = 100 characters (200 UTF-16 units) → still allowed
  assert.equal(V.validateField(F.name, '😀'.repeat(100)).error, null);
});

test('whitespace-only required text counts as empty', () => {
  assert.equal(V.validateField(F.name, '    ').error, 'This field is required.');
  assert.equal(V.validateField(F.feedback, '\n\n  \t').error, 'This field is required.');
});

test('control characters are stripped; newlines kept in long text only', () => {
  assert.equal(V.validateField(F.name, 'Sa\u0000ra\u0007 Ahmed').value, 'Sara Ahmed');
  assert.equal(V.validateField(F.feedback, 'line one is here\r\nline two').value, 'line one is here\nline two');
  assert.equal(V.validateField(F.name, 'Sara\nAhmed').value, 'Sara Ahmed');
});

test('optional phone and age: empty OK, garbage rejected, range enforced', () => {
  assert.equal(V.validateField(F.phone, '').error, null);
  assert.equal(V.validateField(F.phone, '+20 (100) 123-4567').error, null);
  assert.ok(V.validateField(F.phone, 'call me maybe').error);
  assert.ok(V.validateField(F.phone, '12345').error);
  assert.equal(V.validateField(F.age, '').error, null);
  assert.equal(V.validateField(F.age, '32').value, 32);
  for (const bad of ['12', '121', 'abc', '30.5']) assert.ok(V.validateField(F.age, bad).error, bad);
});

test('choice types validate against options (single and multiple)', () => {
  const sel = { id: 'c', type: 'select', required: true, options: [{ value: 'a' }, { value: 'b' }] };
  assert.equal(V.validateField(sel, 'a').error, null);
  assert.ok(V.validateField(sel, 'z').error);
  assert.ok(V.validateField(sel, '').error);
  const multi = { id: 'm', type: 'checkboxes', required: true, options: [{ value: 'x' }, { value: 'y' }] };
  assert.deepEqual(V.validateField(multi, ['x', 'y', 'x']).value, ['x', 'y']);
  assert.ok(V.validateField(multi, ['x', 'evil']).error);
  assert.ok(V.validateField(multi, []).error);
});

test('unknown answer keys are ignored', () => {
  const r = V.validateAll(FIELDS, Object.assign(valid(), { isAdmin: true, __proto__x: 1 }));
  assert.equal(r.valid, true);
  assert.equal('isAdmin' in r.values, false);
});
