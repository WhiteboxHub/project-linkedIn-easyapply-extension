(function () {
  'use strict';
  console.log('CS: content_script loaded (Robust Smart Edition with Manual Pause).');

  const AFTER_NEXT_WAIT_MS = 4000;
  const AFTER_SUBMIT_WAIT_MS = 6000;
  const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

  let isRunning = false;
  let statusBanner = null;

  // -------- UI Helper --------
  function updateStatus(text, isWaiting = false) {
    if (!statusBanner) {
      statusBanner = document.createElement('div');
      statusBanner.style.cssText = 'position:fixed;top:10px;right:10px;z-index:999999;padding:12px 20px;border-radius:8px;font-family:sans-serif;font-weight:bold;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:all 0.3s;';
      document.body.appendChild(statusBanner);
    }
    statusBanner.innerText = 'BOT: ' + text;
    if (isWaiting) {
      statusBanner.style.backgroundColor = '#6c757d'; // Grey
      statusBanner.style.color = '#fff';
      statusBanner.style.border = '2px solid #5a6268';
    } else {
      statusBanner.style.backgroundColor = '#4caf50'; // Green
      statusBanner.style.color = '#fff';
      statusBanner.style.border = '2px solid #388e3c';
    }
  }

  // -------- Utilities --------
  const delay = ms => new Promise(res => setTimeout(res, ms));

  function getLabelText(el) {
    const id = el.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) return label.innerText.trim();
    }
    const parent = el.closest('label');
    if (parent) return parent.innerText.trim();
    const group = el.closest('.jobs-easy-apply-form-element');
    if (group) {
      const lbl = group.querySelector('label') || group.querySelector('.jobs-easy-apply-form-element__label');
      if (lbl) return lbl.innerText.trim();
    }
    return "";
  }

  function hasEmptyRequiredFields() {
    const container = document.querySelector('.jobs-easy-apply-modal__content') || document.body;

    // 1. Check for visible red error messages
    const errors = container.querySelectorAll('.artdeco-inline-feedback--error, .fb-form-element--error');
    if (errors.length > 0) {
      console.log('CS: Error detected on page');
      return true;
    }

    // 2. Scan all form elements
    const groups = container.querySelectorAll('.jobs-easy-apply-form-element');
    for (const group of groups) {
      const isRequired = group.innerText.includes('*') || group.querySelector('[aria-required="true"]');
      if (!isRequired) continue;

      // Find the input
      const input = group.querySelector('input, select, textarea');
      if (!input) continue;

      if (input.type === 'radio' || input.type === 'checkbox') {
        // Check if at least one in the group is checked
        const name = input.name;
        if (name) {
          const checked = container.querySelector(`input[name="${name}"]:checked`);
          if (!checked) {
            console.log('CS: Required radio/checkbox missing:', name);
            return true;
          }
        } else if (!input.checked) {
          return true;
        }
      } else {
        // Text, Select, Textarea
        if (!input.value || input.value.trim() === "" || input.value.includes("Select an option")) {
          console.log('CS: Required field empty:', getLabelText(input));
          return true;
        }
      }
    }
    return false;
  }

  async function fillForm() {
    const container = document.querySelector('.jobs-easy-apply-modal__content') || document.body;

    // Radios (Sponsorship/Visa/etc)
    const fieldsets = container.querySelectorAll('fieldset');
    for (const fs of fieldsets) {
      const legend = fs.querySelector('legend');
      const labelText = (legend ? legend.innerText : fs.innerText || '').toLowerCase();
      let target = null;
      if (labelText.includes('sponsorship') || labelText.includes('visa')) target = 'No';
      else if (labelText.includes('authorized') || labelText.includes('legally')) target = 'Yes';
      else if (labelText.includes('citizen')) target = 'Yes';
      else if (labelText.includes('veteran')) target = 'No';
      else if (labelText.includes('disability')) target = 'No';

      if (target) {
        const inputs = fs.querySelectorAll('input[type="radio"]');
        for (const inp of inputs) {
          const lbl = container.querySelector(`label[for="${inp.id}"]`);
          if (lbl && lbl.innerText.toLowerCase().trim().includes(target.toLowerCase())) {
            if (!inp.checked) {
              updateStatus('Filling Radio: ' + target);
              inp.click();
              await delay(400);
            }
            break;
          }
        }
      }
    }

    // Selects
    const selects = container.querySelectorAll('select');
    for (const sel of selects) {
      if (sel.value && !sel.value.includes("Select")) continue;
      const labelText = getLabelText(sel).toLowerCase();
      let target = null;
      if (labelText.includes('gender')) target = 'Male';
      else if (labelText.includes('proficiency')) target = 'Professional';
      if (target) {
        for (const opt of sel.options) {
          if (opt.text.toLowerCase().includes(target.toLowerCase())) {
            updateStatus('Selecting: ' + target);
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            await delay(400);
            break;
          }
        }
      }
    }

    // Texts
    const texts = container.querySelectorAll('input[type="text"], input[type="number"], textarea');
    for (const inp of texts) {
      if (inp.value && inp.value.trim().length > 0) continue;
      const labelText = getLabelText(inp).toLowerCase();
      let val = null;
      if (labelText.includes('experience') || labelText.includes('years')) val = "15";
      else if (labelText.includes('salary') || labelText.includes('compensation')) val = "50000";
      else if (labelText.includes('notice')) val = "0";
      if (val) {
        updateStatus('Typing: ' + val);
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await delay(400);
      }
    }
  }

  function findBtn(textPattern) {
    const btns = Array.from(document.querySelectorAll('button:not([disabled])'));
    return btns.find(b => textPattern.test(b.innerText) || textPattern.test(b.getAttribute('aria-label') || ''));
  }

  async function runApplySequence(job) {
    updateStatus('Starting Application...');
    isRunning = true;
    let pageCount = 0;
    const MAX_PAGES = 10;

    try {
      const easyBtn = findBtn(/easy apply/i) || document.querySelector('.jobs-apply-button');
      if (!easyBtn) return { applied: false, reason: 'no_easy_apply_btn' };

      easyBtn.click();
      await delay(5000);

      const startTime = Date.now();
      while (Date.now() - startTime < FLOW_TIMEOUT_MS) {
        // 1. FILL
        await fillForm();
        await delay(1000);

        // 2. ACTIONS SEARCH
        const submitBtn = findBtn(/submit application/i);
        const reviewBtn = findBtn(/review/i);
        const nextBtn = findBtn(/next/i) || findBtn(/continue/i);

        // 3. DECISION LOGIC
        if (submitBtn) {
          updateStatus('Submitting Application...');
          submitBtn.click();
          await delay(AFTER_SUBMIT_WAIT_MS);
          const doneBtn = findBtn(/done/i);
          if (doneBtn) doneBtn.click();
          return { applied: true };
        }

        if (reviewBtn) {
          if (pageCount >= MAX_PAGES) {
            updateStatus('Skipping: App execution too long.');
            const dismissBtn = document.querySelector('[aria-label="Dismiss"]');
            if (dismissBtn) dismissBtn.click();
            return { applied: false, reason: 'too_long' };
          }
          updateStatus('Clicking Review');
          reviewBtn.click();
          pageCount++;
          await delay(AFTER_NEXT_WAIT_MS);
          continue;
        }

        if (nextBtn) {
          if (pageCount >= MAX_PAGES) {
            updateStatus('Skipping: App execution too long.');
            const dismissBtn = document.querySelector('[aria-label="Dismiss"]');
            if (dismissBtn) dismissBtn.click();
            await delay(1000);
            const discardBtn = findBtn(/discard/i);
            if (discardBtn) discardBtn.click();
            return { applied: false, reason: 'too_long' };
          }
          updateStatus('Clicking Next');
          nextBtn.click();
          pageCount++;
          await delay(AFTER_NEXT_WAIT_MS);
          continue;
        }

        // 4. WAIT FOR MANUAL INPUT (Only if no buttons found)
        if (hasEmptyRequiredFields()) {
          updateStatus('Waiting for Manual Input... (Fill fields to continue)', true);
          await delay(2000);
          continue;
        }

        if (!document.querySelector('.jobs-easy-apply-modal')) {
          updateStatus('Modal Closed.');
          return { applied: true, reason: 'modal_closed' };
        }
        await delay(2000);
      }
      return { applied: false, reason: 'timeout' };
    } catch (e) {
      updateStatus('Fatal Error: ' + String(e).slice(0, 20), true);
      return { applied: false, error: String(e) };
    } finally {
      isRunning = false;
      setTimeout(() => statusBanner?.remove(), 5000);
    }
  }

  try { chrome.runtime.sendMessage({ action: 'contentScriptReady' }, () => { }); } catch (e) { }
  if (!window.__cs_message_installed) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === 'tryApply') {
        if (isRunning) { sendResponse({ ok: false, error: 'busy' }); return true; }
        runApplySequence(msg.job).then(res => sendResponse({ ok: true, result: res })).catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      return false;
    });
    window.__cs_message_installed = true;
  }
})();
