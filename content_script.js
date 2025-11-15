// content_script.js

(function() {
  console.log('CS: content_script loaded');

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    console.log('CS: received message', msg);
    if (msg.action === 'tryApply') {
      tryApplySequence(msg.job).then(result => {
        sendResponse({ ok: true, result });
      }).catch(err => {
        console.error('CS: tryApplySequence error', err);
        sendResponse({ ok: false, error: String(err) });
      });
      return true; // async
    }
  });

  async function tryApplySequence(job) {
    console.log('CS: tryApplySequence for jobId', job.jobId);

    // 1) try to find easy apply button by text/candidate selectors
    const easyBtn = findEasyApplyButton();
    if (!easyBtn) {
      console.warn('CS: Easy Apply button not found');
      return { applied: false, reason: 'easy_apply_not_found' };
    }

    // Scroll into view and click
    easyBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
    await delay(300);
    try {
      easyBtn.click();
      console.log('CS: clicked Easy Apply button');
    } catch (e) {
      console.error('CS: click failed', e);
      return { applied: false, reason: 'click_failed', error: String(e) };
    }

    // 2) wait for modal to appear and then wait 30 seconds before proceeding
    console.log('CS: waiting 30 seconds before clicking Next button...');
    await delay(30000); // 30 seconds delay

    // 3) Try to find and click the "Next" button
    const nextBtn = findNextButton();
    if (nextBtn) {
      try {
        nextBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
        await delay(200);
        nextBtn.click();
        console.log('CS: clicked Next button after 30 second delay');
        
        // 4) After clicking Next, wait and try to find final submit button
        await delay(2000);
        const submitBtn = findModalSubmitButton();
        if (submitBtn) {
          try {
            submitBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await delay(200);
            submitBtn.click();
            console.log('CS: clicked final submit button');
            return { applied: true };
          } catch (e) {
            console.error('CS: final submit click failed', e);
            return { applied: false, reason: 'final_submit_failed', error: String(e) };
          }
        } else {
          console.log('CS: No final submit button found, application may be in progress');
          return { applied: true, reason: 'next_clicked_but_no_final_submit' };
        }
      } catch (e) {
        console.error('CS: next button click failed', e);
        return { applied: false, reason: 'next_click_failed', error: String(e) };
      }
    } else {
      console.warn('CS: Next button not found after 30 seconds');
      return { applied: false, reason: 'next_button_not_found' };
    }
  }

  function findEasyApplyButton() {
    // Try a few heuristics:
    // 1) button text contains "easy apply" (case-insensitive)
    // 2) a[data-control-name="jobdetails_topcard_inapply"] or similar
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const el of btns) {
      const txt = (el.innerText || '').trim().toLowerCase();
      if (txt.includes('easy apply') || txt.includes('apply now')) return el;
    }
    // fallback: look for common data-control attributes
    const attrEl = document.querySelector('[data-control-name*="inapply"], [data-control-name*="apply"]');
    if (attrEl) return attrEl;
    return null;
  }

  function findNextButton() {
    // Look for Next button with specific attributes from the example
    const candidates = Array.from(document.querySelectorAll('button'));
    for (const el of candidates) {
      const txt = (el.innerText || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      
      // Match the specific button from the example
      if (txt === 'next' || 
          aria.includes('continue to next step') ||
          el.hasAttribute('data-easy-apply-next-button') ||
          el.hasAttribute('data-live-test-easy-apply-next-button')) {
        return el;
      }
    }
    
    // Also try data-test attributes and other common patterns
    const dataTestNext = document.querySelector('[data-test-easy-apply-next-button], [data-easy-apply-next-button]');
    if (dataTestNext) return dataTestNext;
    
    return null;
  }

  function findModalSubmitButton() {
    // Heuristics for modal submit buttons:
    const candidates = Array.from(document.querySelectorAll('button'));
    for (const el of candidates) {
      const txt = (el.innerText || '').trim().toLowerCase();
      if (txt === 'submit application' || txt === 'submit' || txt === 'review' || txt === 'send') {
        return el;
      }
      // buttons with aria-labels
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('submit') || aria.includes('send')) return el;
    }
    // sometimes the primary button has role=button and data-test attributes
    const primary = document.querySelector('[data-test-primary-btn], [data-control-name="submit_unified_apply"]');
    if (primary) return primary;
    return null;
  }

  function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
})();