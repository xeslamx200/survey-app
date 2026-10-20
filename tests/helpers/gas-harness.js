/**
 * Runs the real apps-script/Code.gs inside a Node VM with in-memory mocks of
 * the Apps Script services it uses (SpreadsheetApp, LockService, CacheService,
 * ContentService, Utilities, Session).
 *
 * This lets us test the backend's validation, sheet setup, idempotency, rate
 * limiting and formula-injection protection without a Google account.
 * It does NOT prove behaviour on Google's servers — see docs/TESTING.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const CODE_PATH = path.join(__dirname, '..', '..', 'apps-script', 'Code.gs');

/* ---------------- In-memory spreadsheet ---------------- */

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) {
      throw new Error(`Invalid range r${row} c${col} ${numRows}x${numCols}`);
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const rowArr = this.sheet.data[this.row - 1 + r] || [];
        const v = rowArr[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some((l) => l.length !== this.numCols)) {
      throw new Error('setValues: dimensions do not match range');
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.setCell(this.row + r, this.col + c, v)));
    return this;
  }
  setFontWeight(w) { this.sheet.formats.push({ kind: 'fontWeight', row: this.row, col: this.col, w }); return this; }
  setNumberFormat(f) { this.sheet.formats.push({ kind: 'numberFormat', row: this.row, col: this.col, f }); return this; }
}

class MockSheet {
  constructor(name) {
    this.name = name;
    this.data = [];      // data[rowIndex][colIndex]
    this.formats = [];
    this.frozenRows = 0;
    this.appendCount = 0;
  }
  getName() { return this.name; }
  setCell(row, col, v) {
    while (this.data.length < row) this.data.push([]);
    const line = this.data[row - 1];
    while (line.length < col) line.push('');
    line[col - 1] = v;
  }
  getLastRow() {
    for (let r = this.data.length; r >= 1; r--) {
      if ((this.data[r - 1] || []).some((v) => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.data.forEach((line) => line.forEach((v, i) => { if (v !== '' && v !== undefined && v !== null) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return Math.max(1000, this.data.length); }
  getRange(row, col, numRows = 1, numCols = 1) { return new MockRange(this, row, col, numRows, numCols); }
  appendRow(values) {
    const r = this.getLastRow() + 1;
    values.forEach((v, i) => this.setCell(r, i + 1, v));
    this.appendCount++;
    return this;
  }
  setFrozenRows(n) { this.frozenRows = n; }
}

class MockSpreadsheet {
  constructor() { this.sheets = []; this.timeZone = 'UTC'; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('Sheet exists: ' + name);
    const s = new MockSheet(name);
    this.sheets.push(s);
    return s;
  }
  setSpreadsheetTimeZone(tz) { this.timeZone = tz; }
}

/* ---------------- Harness ---------------- */

function formatDate(date, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return fmt
    .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.config]  overrides merged into Code.gs CONFIG
 * @param {MockSpreadsheet} [opts.spreadsheet]
 */
function createBackend(opts = {}) {
  const spreadsheet = opts.spreadsheet || new MockSpreadsheet();
  const cacheStore = new Map();
  const lock = { busy: false, acquired: 0, released: 0, held: false };
  const logs = [];
  let flushes = 0;

  const sandbox = {
    console: {
      log: (...a) => logs.push(['log', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')])
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: () => spreadsheet,
      flush: () => { flushes++; }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lock.busy) return false;
          if (lock.held) throw new Error('Lock re-entered: lock not released by a previous call');
          lock.held = true; lock.acquired++; return true;
        },
        releaseLock: () => { lock.held = false; lock.released++; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => { cacheStore.set(k, String(v)); }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (content) => {
        const out = { content, mime: 'text/plain' };
        out.setMimeType = (m) => { out.mime = m; return out; };
        out.getContent = () => out.content;
        return out;
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      getUuid: () => crypto.randomUUID(),
      formatDate,
      computeDigest: (alg, str) => Array.from(crypto.createHash(alg).update(str, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b))
    },
    Session: { getScriptTimeZone: () => 'UTC' }
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), ctx, { filename: 'Code.gs' });
  if (opts.config) Object.assign(ctx.CONFIG, opts.config);

  /** Simulate an HTTP POST with a raw body; returns the parsed JSON reply. */
  function post(body) {
    const contents = typeof body === 'string' ? body : JSON.stringify(body);
    const out = ctx.doPost({ postData: { contents, type: 'text/plain' }, parameter: {} });
    return { mime: out.mime, json: JSON.parse(out.getContent()), raw: out.getContent() };
  }

  function get() {
    const out = ctx.doGet({ parameter: {} });
    return { mime: out.mime, json: JSON.parse(out.getContent()) };
  }

  function rows(sheetName) {
    const s = spreadsheet.getSheetByName(sheetName || ctx.CONFIG.SHEET_NAME);
    if (!s) return { headers: [], rows: [] };
    const all = s.data.map((l) => l.slice());
    return { headers: all[0] || [], rows: all.slice(1) };
  }

  return { ctx, spreadsheet, cacheStore, lock, logs, post, get, rows, get flushes() { return flushes; } };
}

/** A valid request payload; override parts as needed. */
function validPayload(over = {}) {
  return {
    version: 1,
    submissionId: over.submissionId || crypto.randomUUID(),
    answers: Object.assign({
      name: 'Sara Ahmed',
      email: 'Sara@Example.com',
      phone: '+20 100 123 4567',
      age: 32,
      rating: 4,
      feedback: 'Great service, quick replies.',
      consent: true
    }, over.answers || {}),
    meta: Object.assign({ elapsedMs: 15000, hp: '' }, over.meta || {})
  };
}

module.exports = { createBackend, validPayload, MockSpreadsheet, MockSheet };
