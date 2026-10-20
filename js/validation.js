/**
 * Client-side validation and normalization.
 *
 * Runs in the browser (exposed as window.SurveyValidation) and in Node for
 * automated tests (module.exports). The backend repeats every check
 * independently in Code.gs — this file only exists to give users fast,
 * friendly feedback. Never rely on it for security.
 */
(function (root) {
  'use strict';

  // Practical email pattern: one @, no spaces, a dot in the domain, a 2+ letter TLD.
  // Deliberately the same pattern as Code.gs.
  var EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/;
  var PHONE_RE = /^\+?[0-9\s().\-]+$/;
  // Control characters except tab (\u0009) and newline (\u000A).
  var CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

  var DEFAULT_MAX_TEXT = 500;

  /** Normalize a raw string: unify line endings, strip control chars, trim. */
  function cleanString(value, multiline) {
    if (value === null || value === undefined) return '';
    var s = String(value);
    if (typeof s.normalize === 'function') s = s.normalize('NFC');
    s = s.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
    if (!multiline) s = s.replace(/\s+/g, ' ');
    return s.trim();
  }

  function isEmpty(v) {
    return v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === false;
  }

  function optionValues(field) {
    return (field.options || []).map(function (o) { return String(o.value); });
  }

  function lengthOf(s) {
    // Count user-perceived characters (code points), not UTF-16 units.
    return Array.from(s).length;
  }

  /**
   * Validate and normalize one field.
   * @returns {{ value: *, error: string|null }}
   */
  function validateField(field, raw) {
    var label = field.label || field.id;
    var value;

    switch (field.type) {
      case 'text':
      case 'email':
      case 'tel':
      case 'textarea': {
        value = cleanString(raw, field.type === 'textarea');
        if (value === '') {
          return { value: '', error: field.required ? requiredMsg(field) : null };
        }
        var max = field.maxLength || DEFAULT_MAX_TEXT;
        var len = lengthOf(value);
        if (field.minLength && len < field.minLength) {
          return { value: value, error: 'Please enter at least ' + field.minLength + ' characters.' };
        }
        if (len > max) {
          return { value: value, error: 'Please keep this under ' + max + ' characters (currently ' + len + ').' };
        }
        if (field.type === 'email') {
          value = value.toLowerCase();
          if (!EMAIL_RE.test(value)) {
            return { value: value, error: 'Please enter a valid email address, like name@example.com.' };
          }
        }
        if (field.type === 'tel') {
          var digits = value.replace(/\D/g, '');
          if (!PHONE_RE.test(value) || digits.length < 6 || digits.length > 15) {
            return { value: value, error: 'Please enter a valid phone number (digits, spaces, +, - and brackets only).' };
          }
        }
        return { value: value, error: null };
      }

      case 'number':
      case 'rating': {
        var s = cleanString(raw, false);
        if (s === '') {
          return { value: '', error: field.required ? requiredMsg(field) : null };
        }
        if (!/^-?\d+$/.test(s)) {
          return { value: s, error: field.type === 'rating' ? 'Please choose a rating.' : 'Please enter a whole number.' };
        }
        var n = parseInt(s, 10);
        var min = typeof field.min === 'number' ? field.min : -Infinity;
        var maxN = typeof field.max === 'number' ? field.max : Infinity;
        if (n < min || n > maxN) {
          return {
            value: n,
            error: field.type === 'rating'
              ? 'Please choose a rating from ' + min + ' to ' + maxN + '.'
              : 'Please enter a number between ' + min + ' and ' + maxN + '.'
          };
        }
        return { value: n, error: null };
      }

      case 'select':
      case 'radio': {
        value = cleanString(raw, false);
        if (value === '') return { value: '', error: field.required ? requiredMsg(field) : null };
        if (optionValues(field).indexOf(value) === -1) {
          return { value: '', error: 'Please choose one of the listed options.' };
        }
        return { value: value, error: null };
      }

      case 'checkboxes': {
        var arr = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw]);
        var allowed = optionValues(field);
        var seen = {};
        var out = [];
        for (var i = 0; i < arr.length; i++) {
          var v = cleanString(arr[i], false);
          if (allowed.indexOf(v) === -1) return { value: [], error: 'Please choose from the listed options.' };
          if (!seen[v]) { seen[v] = true; out.push(v); }
        }
        if (out.length === 0) return { value: [], error: field.required ? requiredMsg(field) : null };
        return { value: out, error: null };
      }

      case 'consent': {
        var checked = raw === true || raw === 'true' || raw === 'on' || raw === 'yes';
        if (!checked && field.required) {
          return { value: false, error: 'Please confirm this to submit your response.' };
        }
        return { value: checked, error: null };
      }

      default:
        return { value: '', error: 'Unsupported field type: ' + field.type };
    }
  }

  function requiredMsg(field) {
    if (field.type === 'rating') return 'Please choose a rating.';
    if (field.type === 'select' || field.type === 'radio' || field.type === 'checkboxes') return 'Please choose an option.';
    if (field.type === 'email') return 'Please enter your email address.';
    return 'This field is required.';
  }

  /** Flatten the sections of a config into a single list of fields. */
  function getFields(config) {
    var list = [];
    (config.sections || []).forEach(function (sec) {
      (sec.fields || []).forEach(function (f) { list.push(f); });
    });
    return list;
  }

  /**
   * Validate all answers. Unknown keys in `answers` are ignored.
   * @returns {{ values: Object, errors: Object, valid: boolean }}
   */
  function validateAll(fields, answers) {
    var values = {};
    var errors = {};
    answers = answers || {};
    fields.forEach(function (f) {
      var r = validateField(f, answers[f.id]);
      values[f.id] = r.value;
      if (r.error) errors[f.id] = r.error;
    });
    return { values: values, errors: errors, valid: Object.keys(errors).length === 0 };
  }

  var api = {
    EMAIL_RE: EMAIL_RE,
    cleanString: cleanString,
    isEmpty: isEmpty,
    validateField: validateField,
    validateAll: validateAll,
    getFields: getFields
  };

  root.SurveyValidation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
