/**
 * Survey app: renders the form from SURVEY_CONFIG, validates input, submits to
 * the Google Apps Script Web App, and shows confirmed success or a clear error.
 *
 * Submission protocol (see docs/SECURITY.md → "Cross-origin requests"):
 *   POST <endpoint>   Content-Type: text/plain;charset=utf-8   (no CORS preflight)
 *   body: {"version":1,"submissionId":"…","answers":{…},"meta":{"elapsedMs":…,"hp":""}}
 *   Apps Script answers with a 302 to script.googleusercontent.com, which fetch
 *   follows automatically; that final response is readable JSON:
 *     {"ok":true,"responseId":"R-…","timestamp":"…"}
 *     {"ok":false,"error":{"code":"VALIDATION_ERROR","message":"…","fields":{…}}}
 *   Success is shown ONLY when the body says ok:true with a responseId.
 */
(function () {
  'use strict';

  var C = window.SURVEY_CONFIG;
  var V = window.SurveyValidation;
  if (!C || !V) {
    console.error('Survey: form-config.js or validation.js failed to load.');
    return;
  }

  var FIELDS = V.getFields(C);
  var FIELD_BY_ID = {};
  FIELDS.forEach(function (f) { FIELD_BY_ID[f.id] = f; });

  var state = {
    status: 'idle',          // idle | submitting | success
    attempted: false,        // has the user tried to submit?
    touched: {},             // fields the user has left at least once
    startedAt: Date.now(),
    submissionId: newSubmissionId()
  };

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    form: $('survey-form'),
    sections: $('form-sections'),
    progress: $('progress'),
    progressText: $('progress-text'),
    progressBar: $('progress-bar'),
    summary: $('error-summary'),
    submitBtn: $('submit-btn'),
    submitLabel: $('submit-label'),
    submitStatus: $('submit-status'),
    submitError: $('submit-error'),
    submitErrorTitle: $('submit-error-title'),
    submitErrorMsg: $('submit-error-message'),
    retryBtn: $('retry-btn'),
    success: $('success-panel'),
    successTitle: $('success-title'),
    successMsg: $('success-message'),
    successRef: $('success-ref'),
    againBtn: $('again-btn'),
    honeypot: $('hp_field')
  };

  /* ================================================================
     Helpers
     ================================================================ */

  function newSubmissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function inputId(f) { return 'f-' + f.id; }
  function errorId(f) { return f.id + '-error'; }
  function helpId(f) { return f.id + '-help'; }

  function labelChildren(f) {
    return [
      f.label,
      f.required
        ? h('span', { class: 'req', 'aria-hidden': 'true', text: '*' })
        : h('span', { class: 'field__optional', text: '(optional)' })
    ];
  }

  function describedBy(f) {
    return [f.help ? helpId(f) : null, errorId(f)].filter(Boolean).join(' ');
  }

  /* ================================================================
     Rendering
     ================================================================ */

  function bindText() {
    document.querySelectorAll('[data-bind]').forEach(function (node) {
      var key = node.getAttribute('data-bind');
      if (typeof C[key] === 'string') node.textContent = C[key];
    });
    if (C.title) document.title = C.title + (C.brandName ? ' · ' + C.brandName : '');
    el.submitLabel.textContent = C.submitLabel || 'Submit';
    el.againBtn.textContent = C.submitAnotherLabel || 'Submit another response';
    var year = $('year');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  function renderForm() {
    var frag = document.createDocumentFragment();
    C.sections.forEach(function (sec, i) {
      var legendId = 'sec-' + (sec.id || i) + '-title';
      var fs = h('fieldset', { class: 'section', 'aria-labelledby': legendId }, [
        h('legend', { class: 'section__legend', id: legendId, text: sec.title || '' }),
        sec.description ? h('p', { class: 'section__desc', text: sec.description }) : null
      ]);
      var grid = h('div', { class: 'section__fields' });
      (sec.fields || []).forEach(function (f) { grid.appendChild(renderField(f)); });
      fs.appendChild(grid);
      frag.appendChild(fs);
    });
    el.sections.appendChild(frag);
  }

  function renderField(f) {
    var short = (f.type === 'text' || f.type === 'email' || f.type === 'tel' || f.type === 'number' || f.type === 'select');
    // Name and email pair up; everything else spans the full width.
    var wrap = h('div', {
      class: 'field' + (short ? '' : ' field--full'),
      id: 'field-' + f.id,
      'data-field-id': f.id
    });

    var help = f.help ? h('span', { class: 'field__help', id: helpId(f), text: f.help }) : null;
    var error = h('p', { class: 'field__error', id: errorId(f) });

    switch (f.type) {
      case 'text':
      case 'email':
      case 'tel':
      case 'number':
        wrap.appendChild(h('label', { class: 'field__label', for: inputId(f) }, labelChildren(f)));
        if (help) wrap.appendChild(help);
        wrap.appendChild(h('input', {
          class: 'input',
          id: inputId(f),
          name: f.id,
          type: f.type === 'number' ? 'text' : f.type,  // text + inputmode avoids number-input quirks
          inputmode: f.inputmode || (f.type === 'number' ? 'numeric' : null),
          pattern: f.type === 'number' ? '[0-9]*' : null,
          autocomplete: f.autocomplete || 'off',
          placeholder: f.placeholder || null,
          maxlength: f.type === 'number' ? 4 : (f.maxLength ? f.maxLength + 20 : null), // soft cap; validator explains
          required: !!f.required,
          'aria-describedby': describedBy(f),
          spellcheck: f.type === 'text' ? null : 'false'
        }));
        wrap.appendChild(error);
        break;

      case 'textarea': {
        wrap.appendChild(h('label', { class: 'field__label', for: inputId(f) }, labelChildren(f)));
        if (help) wrap.appendChild(help);
        wrap.appendChild(h('textarea', {
          class: 'textarea',
          id: inputId(f),
          name: f.id,
          rows: 5,
          placeholder: f.placeholder || null,
          required: !!f.required,
          'aria-describedby': describedBy(f) + ' ' + f.id + '-counter'
        }));
        var meta = h('div', { class: 'field__meta' }, [
          error,
          h('span', { class: 'field__counter', id: f.id + '-counter', 'aria-live': 'off' })
        ]);
        wrap.appendChild(meta);
        break;
      }

      case 'select': {
        wrap.appendChild(h('label', { class: 'field__label', for: inputId(f) }, labelChildren(f)));
        if (help) wrap.appendChild(help);
        var sel = h('select', {
          class: 'select', id: inputId(f), name: f.id,
          required: !!f.required, 'aria-describedby': describedBy(f)
        }, [h('option', { value: '', text: f.placeholder || 'Select an option' })]);
        (f.options || []).forEach(function (o) {
          sel.appendChild(h('option', { value: o.value, text: o.label }));
        });
        wrap.appendChild(sel);
        wrap.appendChild(error);
        break;
      }

      case 'radio':
      case 'checkboxes': {
        var legendId = f.id + '-legend';
        var group = h('fieldset', { class: 'group', 'aria-describedby': describedBy(f), id: inputId(f) + '-group' }, [
          h('legend', { class: 'field__label', id: legendId }, labelChildren(f))
        ]);
        if (help) group.appendChild(help);
        var list = h('div', { class: 'choices' });
        (f.options || []).forEach(function (o, idx) {
          var id = inputId(f) + '-' + idx;
          list.appendChild(h('label', { class: 'choice', for: id }, [
            h('input', {
              type: f.type === 'radio' ? 'radio' : 'checkbox',
              id: id, name: f.id, value: o.value,
              required: f.type === 'radio' && !!f.required
            }),
            h('span', { text: o.label })
          ]));
        });
        group.appendChild(list);
        wrap.appendChild(group);
        wrap.appendChild(error);
        break;
      }

      case 'rating': {
        var min = typeof f.min === 'number' ? f.min : 1;
        var max = typeof f.max === 'number' ? f.max : 5;
        var labels = f.scaleLabels || {};
        var rg = h('fieldset', { class: 'group', 'aria-describedby': describedBy(f), id: inputId(f) + '-group' }, [
          h('legend', { class: 'field__label' }, labelChildren(f))
        ]);
        if (help) rg.appendChild(help);
        var scale = h('div', { class: 'rating' });
        scale.style.setProperty('--count', String(max - min + 1));
        for (var n = min; n <= max; n++) {
          var rid = inputId(f) + '-' + n;
          var text = labels[n] ? n + ' – ' + labels[n] : String(n);
          scale.appendChild(h('label', { class: 'rating__opt', for: rid }, [
            h('input', {
              type: 'radio', id: rid, name: f.id, value: String(n),
              required: !!f.required, 'aria-label': text
            }),
            h('span', { class: 'rating__face', 'aria-hidden': 'true' }, [
              h('span', { class: 'rating__num', text: String(n) }),
              labels[n] ? h('span', { class: 'rating__lbl', text: labels[n] }) : null
            ])
          ]));
        }
        rg.appendChild(scale);
        if (labels[min] || labels[max]) {
          rg.appendChild(h('div', { class: 'rating__ends', 'aria-hidden': 'true' }, [
            h('span', { text: labels[min] || '' }),
            h('span', { text: labels[max] || '' })
          ]));
        }
        wrap.appendChild(rg);
        wrap.appendChild(error);
        break;
      }

      case 'consent':
        wrap.appendChild(h('label', { class: 'consent', for: inputId(f) }, [
          h('input', {
            type: 'checkbox', id: inputId(f), name: f.id, value: 'yes',
            required: !!f.required, 'aria-describedby': describedBy(f)
          }),
          h('span', { class: 'consent__text' }, labelChildren(f))
        ]));
        if (help) wrap.appendChild(help);
        wrap.appendChild(error);
        break;

      default:
        console.warn('Survey: unsupported field type "' + f.type + '" for field "' + f.id + '".');
    }
    return wrap;
  }

  /* ================================================================
     Reading values & showing errors
     ================================================================ */

  function readValue(f) {
    var form = el.form;
    switch (f.type) {
      case 'radio':
      case 'rating': {
        var checked = form.querySelector('input[name="' + f.id + '"]:checked');
        return checked ? checked.value : '';
      }
      case 'checkboxes':
        return Array.prototype.map.call(
          form.querySelectorAll('input[name="' + f.id + '"]:checked'),
          function (i) { return i.value; }
        );
      case 'consent': {
        var cb = $(inputId(f));
        return !!(cb && cb.checked);
      }
      default: {
        var input = $(inputId(f));
        return input ? input.value : '';
      }
    }
  }

  function collectAnswers() {
    var out = {};
    FIELDS.forEach(function (f) { out[f.id] = readValue(f); });
    return out;
  }

  function focusTarget(f) {
    if (f.type === 'radio' || f.type === 'rating' || f.type === 'checkboxes') {
      return el.form.querySelector('input[name="' + f.id + '"]:checked') ||
             el.form.querySelector('input[name="' + f.id + '"]');
    }
    return $(inputId(f));
  }

  function setFieldError(f, message) {
    var wrap = $('field-' + f.id);
    var err = $(errorId(f));
    if (!wrap || !err) return;
    err.textContent = message || '';
    wrap.classList.toggle('field--invalid', !!message);
    var inputs = el.form.querySelectorAll('[name="' + f.id + '"]');
    Array.prototype.forEach.call(inputs, function (i) {
      if (message) i.setAttribute('aria-invalid', 'true');
      else i.removeAttribute('aria-invalid');
    });
  }

  function validateOne(f) {
    var r = V.validateField(f, readValue(f));
    setFieldError(f, r.error);
    return r;
  }

  function showSummary(errors) {
    var ids = FIELDS.filter(function (f) { return errors[f.id]; });
    if (!ids.length) { hideSummary(); return; }
    el.summary.textContent = '';
    el.summary.appendChild(h('strong', {
      class: 'alert__title',
      text: ids.length === 1 ? 'Please fix 1 problem before submitting' : 'Please fix ' + ids.length + ' problems before submitting'
    }));
    var ul = h('ul');
    ids.forEach(function (f) {
      var name = f.shortLabel || String(f.label || f.id).replace(/[?:.!\s]+$/, '');
      var a = h('a', { href: '#field-' + f.id, text: name + ' — ' + errors[f.id] });
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var t = focusTarget(f);
        if (t) { t.focus(); scrollIntoViewSafe($('field-' + f.id)); }
      });
      ul.appendChild(h('li', null, [a]));
    });
    el.summary.appendChild(ul);
    el.summary.hidden = false;
  }

  function hideSummary() {
    el.summary.hidden = true;
    el.summary.textContent = '';
  }

  function scrollIntoViewSafe(node) {
    if (!node || !node.scrollIntoView) return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }

  /* ================================================================
     Progress & counters
     ================================================================ */

  function updateProgress() {
    var required = FIELDS.filter(function (f) { return f.required; });
    if (!required.length) { el.progress.hidden = true; return; }
    var done = required.filter(function (f) { return !V.validateField(f, readValue(f)).error; }).length;
    el.progress.hidden = false;
    el.progressText.textContent = done + ' of ' + required.length + ' required questions answered';
    el.progressBar.style.width = Math.round((done / required.length) * 100) + '%';
  }

  function updateCounter(f) {
    if (f.type !== 'textarea') return;
    var c = $(f.id + '-counter');
    var input = $(inputId(f));
    if (!c || !input) return;
    var len = Array.from(input.value).length;
    var max = f.maxLength || 500;
    c.textContent = len + ' / ' + max;
    c.classList.toggle('field__counter--over', len > max);
  }

  /* ================================================================
     Submission
     ================================================================ */

  function setBusy(busy) {
    state.status = busy ? 'submitting' : (state.status === 'submitting' ? 'idle' : state.status);
    el.submitBtn.disabled = busy;
    el.retryBtn.disabled = busy;
    el.submitBtn.classList.toggle('is-loading', busy);
    el.form.setAttribute('aria-busy', busy ? 'true' : 'false');
    el.submitLabel.textContent = busy ? 'Submitting…' : (C.submitLabel || 'Submit');
    el.submitStatus.textContent = busy ? 'Submitting your response, please wait.' : '';
  }

  function showSubmitError(title, message) {
    el.submitErrorTitle.textContent = title;
    el.submitErrorMsg.textContent = message;
    el.submitError.hidden = false;
    // role="alert" announces it; also move it into view for sighted users.
    scrollIntoViewSafe(el.submitError);
  }

  function hideSubmitError() { el.submitError.hidden = true; }

  function onSubmit(ev) {
    if (ev) ev.preventDefault();
    if (state.status === 'submitting' || state.status === 'success') return; // duplicate-click guard

    state.attempted = true;
    hideSubmitError();

    var result = V.validateAll(FIELDS, collectAnswers());
    FIELDS.forEach(function (f) { setFieldError(f, result.errors[f.id]); });
    updateProgress();

    if (!result.valid) {
      showSummary(result.errors);
      el.summary.focus();
      scrollIntoViewSafe(el.summary);
      return;
    }
    hideSummary();

    if (!isEndpointConfigured()) {
      showSubmitError(
        'This survey is not connected yet',
        'The survey owner still needs to add the Google Apps Script URL to js/form-config.js. Your answers have not been sent.'
      );
      console.error('Survey: SURVEY_CONFIG.endpoint is empty or invalid. See docs/SETUP.md, step 4.');
      return;
    }

    send(result.values);
  }

  function isEndpointConfigured() {
    var url = (C.endpoint || '').trim();
    return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
  }

  function send(values) {
    setBusy(true);

    var payload = {
      version: 1,
      submissionId: state.submissionId,
      answers: values,
      meta: {
        elapsedMs: Date.now() - state.startedAt,
        hp: el.honeypot ? el.honeypot.value : ''
      }
    };

    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, C.requestTimeoutMs || 20000) : null;

    fetch(C.endpoint.trim(), {
      method: 'POST',
      // text/plain is a CORS-"simple" content type: no preflight, which Apps Script cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    })
      .then(function (resp) {
        return resp.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { /* handled below */ }
          return { httpOk: resp.ok, status: resp.status, data: data };
        });
      })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        setBusy(false);
        var d = r.data;
        if (r.httpOk && d && d.ok === true && typeof d.responseId === 'string' && d.responseId) {
          onSuccess(d);
          return;
        }
        if (d && d.ok === false && d.error) {
          onServerError(d.error);
          return;
        }
        console.error('Survey: unexpected response from backend (HTTP ' + r.status + ').', r.data);
        showSubmitError(
          'We couldn’t confirm your response',
          'The survey server sent an unexpected reply, so we can’t be sure your answers were saved. Please try again in a moment.'
        );
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        setBusy(false);
        if (err && err.name === 'AbortError') {
          showSubmitError(
            'The request timed out',
            'The server took too long to answer. Your answers are still here — select “Try again”. If the first attempt did reach us, it will not be counted twice.'
          );
        } else {
          console.error('Survey: network error.', err,
            '\nIf this happens for everyone, check that the Apps Script deployment has "Who has access: Anyone" and that the URL in form-config.js ends in /exec.');
          showSubmitError(
            'Connection problem',
            'We couldn’t reach the survey server. Check your internet connection, then select “Try again”. Your answers have been kept.'
          );
        }
      });
  }

  function onServerError(error) {
    var code = error.code || 'ERROR';
    if (code === 'VALIDATION_ERROR' && error.fields && typeof error.fields === 'object') {
      var errs = {};
      Object.keys(error.fields).forEach(function (id) {
        if (FIELD_BY_ID[id]) errs[id] = String(error.fields[id]);
      });
      FIELDS.forEach(function (f) { setFieldError(f, errs[f.id]); });
      if (Object.keys(errs).length) {
        showSummary(errs);
        el.summary.focus();
        scrollIntoViewSafe(el.summary);
        return;
      }
    }
    var messages = {
      RATE_LIMITED: ['Too many responses right now', 'We’re receiving a lot of responses at the moment. Please wait a minute, then select “Try again”.'],
      TOO_FAST: ['Please take a moment', 'That was submitted very quickly. Please review your answers, then select “Try again”.'],
      BUSY: ['The server is busy', 'Please wait a few seconds, then select “Try again”. Your answers have been kept.'],
      PAYLOAD_TOO_LARGE: ['Your response is too long', 'Please shorten your answers and try again.']
    };
    var m = messages[code] || [
      'We couldn’t submit your response',
      error.message || 'Something went wrong on our side. Please try again in a moment.'
    ];
    showSubmitError(m[0], m[1]);
  }

  function onSuccess(data) {
    state.status = 'success';
    el.form.hidden = true;
    el.progress.hidden = true;
    hideSummary();
    hideSubmitError();
    el.successTitle.textContent = C.successTitle || 'Thank you';
    el.successMsg.textContent = C.successMessage || '';
    el.successRef.textContent = data.responseId;
    el.success.hidden = false;
    el.successTitle.focus();
    scrollIntoViewSafe($('survey-card'));
  }

  function resetForNewResponse() {
    el.form.reset();
    state.status = 'idle';
    state.attempted = false;
    state.touched = {};
    state.startedAt = Date.now();
    state.submissionId = newSubmissionId();
    FIELDS.forEach(function (f) { setFieldError(f, null); updateCounter(f); });
    hideSummary();
    hideSubmitError();
    el.success.hidden = true;
    el.form.hidden = false;
    updateProgress();
    var first = FIELDS[0] && focusTarget(FIELDS[0]);
    if (first) first.focus();
  }

  /* ================================================================
     Events
     ================================================================ */

  function fieldFromEvent(ev) {
    var t = ev.target;
    return t && t.name ? FIELD_BY_ID[t.name] : null;
  }

  function wireEvents() {
    el.form.addEventListener('submit', onSubmit);
    el.retryBtn.addEventListener('click', function () { onSubmit(null); });
    el.againBtn.addEventListener('click', resetForNewResponse);

    var onEdit = function (ev) {
      var f = fieldFromEvent(ev);
      if (!f) return;
      updateCounter(f);
      // Once a field shows an error (or after a submit attempt), re-check live so
      // the error disappears as soon as it is fixed.
      var wrap = $('field-' + f.id);
      if (state.attempted || (wrap && wrap.classList.contains('field--invalid'))) validateOne(f);
      updateProgress();
    };
    el.form.addEventListener('input', onEdit);
    el.form.addEventListener('change', onEdit);

    // On leaving a field, check what was typed — but don't nag about empty
    // required fields until the person actually tries to submit.
    el.form.addEventListener('focusout', function (ev) {
      var f = fieldFromEvent(ev);
      if (!f) return;
      state.touched[f.id] = true;
      var v = readValue(f);
      if (state.attempted || !V.isEmpty(typeof v === 'string' ? v.trim() : v)) validateOne(f);
    });
  }

  /* ================================================================
     Boot
     ================================================================ */

  bindText();
  renderForm();
  wireEvents();
  FIELDS.forEach(updateCounter);
  updateProgress();

  // Expose a tiny hook for automated tests only (no secrets, read-only state).
  window.__survey = { state: state, fields: FIELDS };
})();
