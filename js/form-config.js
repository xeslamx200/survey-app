/**
 * Survey configuration.
 *
 * This is the ONLY file you normally need to edit to change wording, branding,
 * questions, or the backend URL. Rendering logic lives in app.js.
 *
 * IMPORTANT: The backend (apps-script/Code.gs) keeps its own copy of the field
 * rules in its FIELDS list, because the server must never trust the browser.
 * When you add, remove, or change a question here, make the same change there.
 * `npm test` includes a check that both lists stay in sync.
 *
 * Supported field types:
 *   text, email, tel, number, textarea   – free input
 *   select, radio                        – single choice (needs `options`)
 *   checkboxes                           – multiple choice (needs `options`)
 *   rating                               – 1..N scale (uses `min`, `max`, `scaleLabels`)
 *   consent                              – single required checkbox
 *
 * Common properties:
 *   id           unique key; also used as the field name sent to the backend
 *   label        question text
 *   shortLabel   optional short name used in the error summary
 *   help         optional hint shown under the label
 *   placeholder  optional placeholder text
 *   required     true/false
 *   minLength / maxLength   for text-like fields
 *   min / max               for number and rating fields
 *   autocomplete / inputmode  optional HTML hints for mobile keyboards
 */
(function (root) {
  'use strict';

  var SURVEY_CONFIG = {
    /* ---- Branding & copy -------------------------------------------- */
    brandName: 'Your Brand',
    title: 'Customer Experience Survey',
    description:
      'Tell us how we are doing. It takes about two minutes, and every response is read by our team.',
    estimatedTime: '≈ 2 minutes',

    /* ---- Backend ---------------------------------------------------- */
    // Paste your Google Apps Script Web App URL here (it ends in /exec).
    // Example: 'https://script.google.com/macros/s/AKfycb.../exec'
    endpoint: 'https://script.google.com/macros/s/AKfycbyhmYFXUKjrZGJvUk-ZOhBj-tJ8vQFbSrqzATIE6uhlBaLuEVhAcEb8RWrVJ6uIZ1PU/exec',

    // Abort a request that takes longer than this. A timed-out request may
    // still have been saved, so retries reuse the same submission ID and the
    // backend will not create a duplicate row.
    requestTimeoutMs: 20000,

    /* ---- Messages --------------------------------------------------- */
    submitLabel: 'Submit response',
    successTitle: 'Thank you — your response was recorded',
    successMessage:
      'We appreciate you taking the time to share your feedback. Keep the reference below if you need to contact us about your response.',
    submitAnotherLabel: 'Submit another response',

    privacyNotice:
      'Your answers are sent securely to a private Google Sheet that only the survey owner and people they authorize can open. ' +
      'We collect only the information requested in this form and use it to improve our service. ' +
      'Contact the survey owner if you would like your response removed.',

    /* ---- Questions -------------------------------------------------- */
    sections: [
      {
        id: 'about',
        title: 'About you',
        description: 'So we can follow up if needed.',
        fields: [
          {
            id: 'name',
            shortLabel: 'Full name',
            type: 'text',
            label: 'Full name',
            placeholder: 'e.g. Sara Ahmed',
            required: true,
            minLength: 2,
            maxLength: 100,
            autocomplete: 'name'
          },
          {
            id: 'email',
            shortLabel: 'Email',
            type: 'email',
            label: 'Email address',
            placeholder: 'you@example.com',
            required: true,
            maxLength: 254,
            autocomplete: 'email',
            inputmode: 'email'
          },
          {
            id: 'phone',
            shortLabel: 'Phone',
            type: 'tel',
            label: 'Phone number',
            help: 'Include your country code.',
            placeholder: '+20 100 000 0000',
            required: false,
            minLength: 6,
            maxLength: 25,
            autocomplete: 'tel',
            inputmode: 'tel'
          },
          {
            id: 'age',
            shortLabel: 'Age',
            type: 'number',
            label: 'Age',
            placeholder: 'e.g. 32',
            required: false,
            min: 13,
            max: 120,
            inputmode: 'numeric'
          }
        ]
      },
      {
        id: 'experience',
        title: 'Your experience',
        fields: [
          {
            id: 'rating',
            shortLabel: 'Rating',
            type: 'rating',
            label: 'Overall, how satisfied are you?',
            required: true,
            min: 1,
            max: 5,
            scaleLabels: { 1: 'Very poor', 2: 'Poor', 3: 'Okay', 4: 'Good', 5: 'Excellent' }
          },
          {
            id: 'feedback',
            shortLabel: 'Reason for rating',
            type: 'textarea',
            label: 'What is the main reason for your rating?',
            help: 'What worked well, and what could be better?',
            placeholder: 'Share as much or as little detail as you like…',
            required: true,
            minLength: 10,
            maxLength: 2000
          }

          /* ---- More question types (uncomment to use; also add to Code.gs FIELDS) ----
          ,{
            id: 'channel',
            type: 'select',              // or 'radio' for visible buttons
            label: 'How did you hear about us?',
            required: false,
            options: [
              { value: 'search', label: 'Search engine' },
              { value: 'social', label: 'Social media' },
              { value: 'friend', label: 'A friend or colleague' },
              { value: 'other',  label: 'Other' }
            ]
          }
          ,{
            id: 'topics',
            type: 'checkboxes',          // multiple choice
            label: 'Which areas should we improve?',
            required: false,
            options: [
              { value: 'speed',   label: 'Speed' },
              { value: 'quality', label: 'Quality' },
              { value: 'support', label: 'Customer support' },
              { value: 'price',   label: 'Price' }
            ]
          }
          ------------------------------------------------------------------ */
        ]
      },
      {
        id: 'consent-section',
        title: 'Consent',
        fields: [
          {
            id: 'consent',
            shortLabel: 'Consent',
            type: 'consent',
            label:
              'I agree that my answers and contact details may be stored and used to respond to this survey.',
            required: true
          }
        ]
      }
    ]
  };

  root.SURVEY_CONFIG = SURVEY_CONFIG;
  if (typeof module !== 'undefined' && module.exports) module.exports = SURVEY_CONFIG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
