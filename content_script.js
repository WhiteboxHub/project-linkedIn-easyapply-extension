(function () {
  'use strict';
  console.log('CS: content_script (strict-error-guard + mutation-wait) loaded (updated button-priority + modal-scroll)');

  // -------- Config --------
  const EASY_AFTER_WAIT_MIN = 5000;
  const EASY_AFTER_WAIT_MAX = 10000;
  const CLICK_SETTLE_MS = 500;
  const AFTER_NEXT_WAIT_MS = 5000;
  const AFTER_REVIEW_TO_SUBMIT_WAIT_MS = 20000;
  const AFTER_SUBMIT_WAIT_MS = 10000;
  const MAX_PROGRESS_STEPS = 10000;
  const FLOW_TIMEOUT_MS = Number.MAX_SAFE_INTEGER;
  const POLL_DELAY_MS = 700;

  // error wait config
  const ERROR_ICON_POLL_MS = 1500;
  const ERROR_ICON_POLL_FALLBACK_MS = 5000;
  const ERROR_ICON_POST_CLEAR_WAIT_MS = 10000;

  // scroll config
  const SCROLL_TRIES = 6;
  const SCROLL_DELAY_MS = 350;
  const MODAL_SCROLL_FINAL_DELAY_MS = 250;

  const clickHistory = [];

  // handshake
  try { chrome.runtime.sendMessage({ action: 'contentScriptReady' }, () => {}); } catch (e) {}

  if (!window.__cs_message_installed) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.action === 'tryApply') {
        runApplySequence(msg.job).then(res => sendResponse({ ok: true, result: res }))
          .catch(err => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      sendResponse({ ok: false, error: 'unknown_action' });
      return false;
    });
    window.__cs_message_installed = true;
  }

  // ---------- Utilities ----------
  function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
  function safeText(el) { try { return (el && (el.innerText || el.textContent) || '').trim(); } catch (e) { return ''; } }
  function safeAttr(el, name) { try { return (el && el.getAttribute && el.getAttribute(name)) || ''; } catch (e) { return ''; } }
  function isVisible(el) {
    try {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const inViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= (window.innerHeight || document.documentElement.clientHeight) && rect.left <= (window.innerWidth || document.documentElement.clientWidth);
      return inViewport;
    } catch (e) { return false; }
  }
  function elementDescriptor(el) {
    try {
      if (!el) return null;
      const text = safeText(el).slice(0, 120);
      const tag = el.tagName;
      const id = el.id || '';
      const cls = (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).slice(0,3).join(' ') : '';
      return { tag, id, classSnippet: cls, text };
    } catch (e) { return { tag: 'unknown' }; }
  }

  // support shadow roots & same-origin iframes
  function walkRoots(callback) {
    const visited = new Set();
    function walk(root, meta = 'document') {
      try {
        if (!root || visited.has(root)) return null;
        visited.add(root);
        const stop = callback(root, meta);
        if (stop) return stop;
        const all = root.querySelectorAll ? Array.from(root.querySelectorAll('*')) : [];
        for (const el of all) {
          try {
            if (el.shadowRoot) {
              const found = walk(el.shadowRoot, `${meta} -> shadowHost(${el.tagName}${el.id ? `#${el.id}` : ''})`);
              if (found) return found;
            }
            if (el.tagName === 'IFRAME') {
              try {
                const doc = el.contentDocument;
                if (doc) {
                  const found = walk(doc, `${meta} -> iframe(${el.src || 'inline'})`);
                  if (found) return found;
                }
              } catch (e) { /* cross-origin */ }
            }
          } catch (e) { /* ignore per-element errors */ }
        }
      } catch (e) {}
      return null;
    }
    return walk(document, 'document');
  }

  function matchesTextCandidate(txt, patterns) {
    if (!txt) return false;
    const s = txt.trim().toLowerCase();
    for (const p of patterns) {
      if (typeof p === 'string') {
        if (s === p.toLowerCase() || s.includes(p.toLowerCase())) return true;
      } else if (p instanceof RegExp) {
        if (p.test(s)) return true;
      }
    }
    return false;
  }

  // ---------- Improved modal scroll helper ----------
  function getModalRoot() {
    const selectors = [
      '.jobs-easy-apply-modal__content',
      '.artdeco-modal__content.jobs-easy-apply-modal__content',
      '.jobs-easy-apply-modal',
      '.jobs-easy-apply',
      '.application-modal',
      'dialog[role="dialog"]',
      '[role="dialog"]'
    ];
    for (const s of selectors) {
      try {
        const el = document.querySelector(s);
        if (el && isVisible(el)) return el;
      } catch (e) {}
    }
    const foot = Array.from(document.querySelectorAll('footer')).find(f => f && f.querySelector && f.querySelector('button'));
    if (foot) {
      let cur = foot;
      for (let i=0;i<6 && cur;i++) {
        if (cur.matches && (cur.matches('dialog') || cur.className && /modal|dialog/i.test(String(cur.className)))) return cur;
        cur = cur.parentElement;
      }
      return foot.parentElement || foot;
    }
    return null;
  }

  function findScrollableContainer(root) {
    try {
      if (!root) return null;
      if (root.scrollHeight > root.clientHeight) {
        const styleRoot = window.getComputedStyle(root);
        if (/(auto|scroll)/.test(styleRoot.overflowY)) return root;
      }
      const all = Array.from(root.querySelectorAll('*'));
      const scrollables = all.filter(el => {
        try {
          if (!isVisible(el)) return false;
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (!/(auto|scroll)/.test(st.overflowY)) return false;
          return el.scrollHeight > el.clientHeight + 5;
        } catch (e) { return false; }
      });
      if (scrollables.length) {
        for (const s of scrollables) {
          if (s.querySelector && (s.querySelector('form') || s.querySelector('footer') || s.querySelector('button'))) return s;
        }
        scrollables.sort((a,b) => b.scrollHeight - a.scrollHeight);
        return scrollables[0];
      }
      const form = root.querySelector && root.querySelector('form');
      if (form && form.scrollHeight > (root.clientHeight || 0)) return form;
    } catch (e) {}
    return null;
  }

  async function scrollModalToBottom() {
    try {
      const modalRoot = getModalRoot();
      let container = null;
      if (modalRoot) {
        container = findScrollableContainer(modalRoot) || modalRoot;
      } else {
        const possible = Array.from(document.querySelectorAll('div,section')).find(n => {
          try { return isVisible(n) && (n.scrollHeight > 600 && n.clientHeight < n.scrollHeight); } catch (e) { return false; }
        });
        container = possible || (document.scrollingElement || document.documentElement || document.body);
      }

      if (!container) {
        console.warn('CS: scrollModalToBottom - no container found, scrolling window as fallback');
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
        await delay(MODAL_SCROLL_FINAL_DELAY_MS);
        return false;
      }

      console.log('CS: scrollModalToBottom - chosen container:', elementDescriptor(container));

      let last = -1;
      for (let i=0;i<SCROLL_TRIES;i++) {
        try {
          if (container.scrollTo) {
            container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
          } else {
            container.scrollTop = container.scrollHeight;
          }
        } catch (e) {
          try { container.scrollTop = container.scrollHeight; } catch (_) {}
        }

        try {
          const footer = container.querySelector && (container.querySelector('footer') || container.querySelector('.jobs-easy-apply-footer__info') || container.querySelector('.jobs-easy-apply-footer'));
          if (footer) {
            footer.scrollIntoView({ block: 'end', behavior: 'auto' });
          } else {
            const btn = container.querySelector && (container.querySelector('button[data-live-test-easy-apply-review-button], button[aria-label*="Review"], button[aria-label*="Submit"], button[id^="ember"]'));
            if (btn) btn.scrollIntoView({ block: 'center', behavior: 'auto' });
          }
        } catch (e) {}

        await delay(SCROLL_DELAY_MS);
        const cur = container.scrollTop || (container.scrollY || 0);
        if (cur === last) break;
        last = cur;
      }


      await delay(MODAL_SCROLL_FINAL_DELAY_MS);
      console.log('CS: scrollModalToBottom -> done for container:', elementDescriptor(container));
      return true;
    } catch (e) {
      console.warn('CS: scrollModalToBottom failed', e);
      return false;
    }
  }

  // ---------- Error detection (tight) ----------
  function findErrorContainerCandidate() {
    const containerSelectors = [
      '[data-test-form-element-error-messages]',
      '.artdeco-inline-feedback--error',
      '[role="alert"]'
    ];

    const byContainer = walkRoots((root) => {
      try {
        for (const sel of containerSelectors) {
          if (!root.querySelectorAll) continue;
          const nodes = Array.from(root.querySelectorAll(sel));
          for (const n of nodes) {
            try {
              if (!isVisible(n)) continue;
              const msgEl = n.querySelector && (n.querySelector('.artdeco-inline-feedback__message') || n.querySelector('[data-test-form-element-error-messages]'));
              const msgText = msgEl && msgEl.textContent && msgEl.textContent.trim();
              const hasSvg = !!(n.querySelector && n.querySelector('svg'));
              if (msgText || hasSvg) return n;
            } catch (e) {}
          }
        }
      } catch (e) {}
      return null;
    });

    if (byContainer) return byContainer;

    const svgCandidate = walkRoots((root) => {
      try {
        const svgs = (root.querySelectorAll && Array.from(root.querySelectorAll('svg.mercado-match, svg'))) || [];
        for (const s of svgs) {
          try {
            if (!isVisible(s)) continue;
            const ancestor = s.closest && s.closest('div');
            if (!ancestor) continue;
            const msg = (ancestor.querySelector && (ancestor.querySelector('.artdeco-inline-feedback__message') || ancestor.querySelector('[data-test-form-element-error-messages]'))) ||
                        (ancestor.parentElement && ancestor.parentElement.querySelector && ancestor.parentElement.querySelector('.artdeco-inline-feedback__message'));
            const msgText = msg && msg.textContent && msg.textContent.trim();
            if (msgText) return ancestor;
          } catch (e) {}
        }
      } catch (e) {}
      return null;
    });

    if (svgCandidate) return svgCandidate;
    return null;
  }

  function isErrorIconVisible() {
    try {
      const node = findErrorContainerCandidate();
      return !!node && isVisible(node);
    } catch (e) { return false; }
  }

  function findFormRootForError() {
    try {
      const node = findErrorContainerCandidate();
      if (!node) return null;
      const candidates = ['.jobs-easy-apply-modal', '.jobs-easy-apply', '.application-modal', 'dialog', '[role="dialog"]', '.ember-view'];
      for (const sel of candidates) {
        const root = node.closest && node.closest(sel);
        if (root) return root;
      }
      let cur = node;
      for (let i = 0; i < 8 && cur; i++) {
        cur = cur.parentElement;
        if (!cur) break;
        if ((cur.querySelectorAll && cur.querySelectorAll('input,button,select').length > 2) || cur.getAttribute && cur.getAttribute('role') === 'dialog') {
          return cur;
        }
      }
      return node.parentElement || node;
    } catch (e) { return null; }
  }

  async function waitForErrorIconClearForever({ jobId = null, checkModalStillOpen = true } = {}) {
    try {
      if (jobId && chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ __cs_waiting_job: jobId, __cs_waiting_since: Date.now() }, () => {});
      }
    } catch (e) { console.warn('CS: storage.set failed', e); }

    console.log('CS: waitForErrorIconClearForever - using MutationObserver (jobId=', jobId, ')');

    if (!isErrorIconVisible()) {
      try { if (jobId && chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove(['__cs_waiting_job','__cs_waiting_since']); } catch (e) {}

      try { await scrollModalToBottom(); } catch (e) {}
      return true;
    }

    const formRoot = findFormRootForError();
    function visibilityHandler() { console.log('CS: document.visibilityState=', document.visibilityState); }
    document.addEventListener('visibilitychange', visibilityHandler);

    let resolved = false;
    let pollTimer = null;
    let observer = null;

    function cleanup() {
      try { if (observer) observer.disconnect(); } catch (e) {}
      try { if (pollTimer) clearInterval(pollTimer); } catch (e) {}
      try { document.removeEventListener('visibilitychange', visibilityHandler); } catch (e) {}
      try { if (jobId && chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove(['__cs_waiting_job','__cs_waiting_since']); } catch (e) {}
    }

    const promiseObserver = new Promise((resolve) => {
      try {
        const startTs = Date.now();
        const checkAndResolve = () => {
          if (checkModalStillOpen && formRoot && !document.contains(formRoot)) {
            console.warn('CS: waitForErrorIconClearForever - form/modal removed while waiting');
            cleanup();
            resolved = true;
            resolve(false);
            return;
          }
          const node = findErrorContainerCandidate();
          if (!node || !isVisible(node)) {
            console.log('CS: waitForErrorIconClearForever - observer detected icon cleared after', Math.round((Date.now()-startTs)/1000), 's');
            cleanup();
            resolved = true;
            resolve(true);
            return;
          }
        };

        observer = new MutationObserver((mutations) => {
          try { checkAndResolve(); } catch (e) {}
        });

        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden', 'hidden'] });

        checkAndResolve();

        pollTimer = setInterval(() => {
          try {
            if (resolved) return;
            const node = findErrorContainerCandidate();
            console.log('CS: waitForErrorIconClearForever - fallback poll check; node=', node ? elementDescriptor(node) : null, 'visibilityState=', document.visibilityState);
            if (checkModalStillOpen && formRoot && !document.contains(formRoot)) {
              console.warn('CS: waitForErrorIconClearForever - form/modal removed during fallback poll');
              cleanup();
              resolved = true;
              resolve(false);
              return;
            }
            if (!node || !isVisible(node)) {
              cleanup();
              resolved = true;
              resolve(true);
              return;
            }
          } catch (e) {}
        }, ERROR_ICON_POLL_FALLBACK_MS);
      } catch (e) {
        console.warn('CS: MutationObserver setup failed, falling back to polling', e);
        if (observer) try { observer.disconnect(); } catch (_) {}
        if (pollTimer) try { clearInterval(pollTimer); } catch (_) {}
        resolve(null);
      }
    });

    const observerResult = await promiseObserver;
    if (observerResult === null) {
      console.log('CS: waitForErrorIconClearForever - observer unavailable, using polling fallback');
      try {
        if (formRoot && !document.contains(formRoot)) {
          console.warn('CS: waitForErrorIconClearForever - form/modal already gone (fallback start)');
          try { if (jobId && chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove(['__cs_waiting_job','__cs_waiting_since']); } catch (e) {}
          document.removeEventListener('visibilitychange', visibilityHandler);
          return false;
        }
        while (true) {
          await delay(ERROR_ICON_POLL_MS);
          const node = findErrorContainerCandidate();
          console.log('CS: waitForErrorIconClearForever - poll (fallback) node=', node ? elementDescriptor(node) : null);
          if (checkModalStillOpen && formRoot && !document.contains(formRoot)) {
            console.warn('CS: waitForErrorIconClearForever - form/modal disappeared during fallback poll');
            try { if (jobId && chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove(['__cs_waiting_job','__cs_waiting_since']); } catch (e) {}
            document.removeEventListener('visibilitychange', visibilityHandler);
            return false;
          }
          if (!node || !isVisible(node)) {
            try { if (jobId && chrome && chrome.storage && chrome.storage.local) chrome.storage.local.remove(['__cs_waiting_job','__cs_waiting_since']); } catch (e) {}
            document.removeEventListener('visibilitychange', visibilityHandler);

            try { await scrollModalToBottom(); } catch (e) {}
            return true;
          }
        }
      } finally {}
    } else {
      document.removeEventListener('visibilitychange', visibilityHandler);

      try { await scrollModalToBottom(); } catch (e) {}
      return observerResult;
    }
  }


  async function ensureNoErrorBeforeClick({ jobId = null } = {}) {
    try {
      if (!isErrorIconVisible()) {
        try { await scrollModalToBottom(); } catch (e) {}
        return true;
      }
      console.log('CS: ensureNoErrorBeforeClick - error visible; will wait until it clears before clicking (jobId=', jobId, ')');
      const cleared = await waitForErrorIconClearForever({ jobId, checkModalStillOpen: true });
      if (!cleared) {
        console.warn('CS: ensureNoErrorBeforeClick - aborted waiting because form disappeared');
        return false;
      }
      console.log('CS: ensureNoErrorBeforeClick - error cleared; waiting post-clear', ERROR_ICON_POST_CLEAR_WAIT_MS, 'ms');
      await delay(ERROR_ICON_POST_CLEAR_WAIT_MS);

      try { await scrollModalToBottom(); console.log('CS: scroll after error-clear performed (ensureNoErrorBeforeClick)'); } catch (e) { console.warn('CS: scroll after error-clear failed', e); }
      if (isErrorIconVisible()) {
        console.warn('CS: ensureNoErrorBeforeClick - error visible again after post-clear delay; will re-wait');
        return ensureNoErrorBeforeClick({ jobId });
      }
      return true;
    } catch (e) {
      console.error('CS: ensureNoErrorBeforeClick exception', e);
      return false;
    }
  }

  // ---------- Finders (improved submit detection) ----------
  function findEasyApplyButton() {
    const patterns = [/\beasy apply\b/i, /apply now/i, /\bapply\b/i];
    return walkRoots((root) => {
      const candidates = (root.querySelectorAll && Array.from(root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'))) || [];
      for (const el of candidates) {
        try {
          if (!isVisible(el)) continue;
          const text = (safeText(el) || safeAttr(el,'aria-label') || safeAttr(el,'title')).slice(0,200);
          if (matchesTextCandidate(text, patterns)) return el;
          const span = el.querySelector && el.querySelector('span');
          if (span && matchesTextCandidate(safeText(span), patterns)) return el;
        } catch (e) {}
      }
      return null;
    });
  }

  function findNextCandidate() {
    const patterns = [/^next$/i, /\bnext\b/i, /\bcontinue\b/i, /save\s*&\s*continue/i, /save and continue/i, /\bforward\b/i];
    return walkRoots((root) => {
      const spans = (root.querySelectorAll && Array.from(root.querySelectorAll('span,button'))) || [];
      for (const el of spans) {
        try {
          if (!isVisible(el)) continue;
          const txt = (safeText(el) || safeAttr(el,'aria-label') || safeAttr(el,'value')).slice(0,200);
          if (matchesTextCandidate(txt, patterns)) {
            let btn = el.closest && el.closest('button');
            if (!btn) {
              const tag = (el.tagName || '').toLowerCase();
              if (tag === 'button' || tag === 'a' || el.getAttribute && el.getAttribute('role') === 'button') btn = el;
            }
            if (btn) return { el: btn, reason: 'text-match' };
          }
        } catch (e) {}
      }
      try {
        const btns = (root.querySelectorAll && Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'))) || [];
        for (const b of btns) {
          try {
            if (!isVisible(b)) continue;
            const txt = (safeText(b) || safeAttr(b,'aria-label') || safeAttr(b,'value')).slice(0,200);
            if (matchesTextCandidate(txt, patterns) || b.hasAttribute('data-easy-apply-next-button') || b.hasAttribute('data-live-test-easy-apply-next-button')) {
              return { el: b, reason: 'btn-scan' };
            }
          } catch (e) {}
        }
      } catch (e) {}
      return null;
    });
  }

  function findReviewCandidate() {
    const patterns = [/\breview\b/i, /review your application/i, /review and submit/i];
    return walkRoots((root) => {
      const nodes = (root.querySelectorAll && Array.from(root.querySelectorAll('button, [role="button"], span, a, input'))) || [];
      for (const n of nodes) {
        try {
          if (!isVisible(n)) continue;
          const txt = (safeText(n) || safeAttr(n,'aria-label') || safeAttr(n,'value')).slice(0,200);
          if (matchesTextCandidate(txt, patterns)) {
            let btn = n.closest && n.closest('button');
            if (!btn) {
              const tag = (n.tagName || '').toLowerCase();
              if (tag === 'button' || tag === 'a' || n.getAttribute && n.getAttribute('role') === 'button') btn = n;
            }
            if (btn) return { el: btn, reason: 'text-match' };
          }
        } catch (e) {}
      }
      return null;
    });
  }

  function findSubmitCandidate() {
    const patterns = [/\bsubmit application\b/i, /\bsubmit\b/i, /\bfinish\b/i, /\bconfirm\b/i];
    return walkRoots((root) => {
      const btns = (root.querySelectorAll && Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'))) || [];
      for (const b of btns) {
        try {
          if (!isVisible(b)) continue;
          const txt = (safeText(b) || safeAttr(b,'aria-label') || safeAttr(b,'value')).slice(0,200);
          if (!matchesTextCandidate(txt, patterns)) continue;
          const dialogAncestor = b.closest && (b.closest('.jobs-easy-apply-modal') || b.closest('.jobs-easy-apply') || b.closest('[role="dialog"]') || b.closest('dialog'));
          if (dialogAncestor) return b;
          if (b.id === 'jobs-apply-button-id') {
            const ancestor = b.closest && (b.closest('.jobs-easy-apply-modal') || b.closest('[role="dialog"]') || b.closest('dialog'));
            if (ancestor) return b;
          }
        } catch (e) {}
      }
      return null;
    });
  }

  function findAndCheckReviewButton() {
    try {
      const byId = document.getElementById('ember253');
      if (byId && isVisible(byId)) {
        const clickable = !byId.disabled && getComputedStyle(byId).pointerEvents !== 'none';
        return { exists: true, el: byId, clickable, reason: 'id' };
      }
    } catch (e) {}
    const candidate = findReviewCandidate();
    if (candidate && candidate.el) {
      const el = candidate.el;
      try {
        const style = window.getComputedStyle(el);
        return { exists: true, el, clickable: !el.disabled, reason: candidate.reason || 'fallback' };
      } catch (e) {
        return { exists: true, el, clickable: !el.disabled, reason: candidate.reason || 'fallback' };
      }
    }
    return { exists: false };
  }

  // ---------- Robust click ----------
  async function robustClick(el) {
    if (!el) return { ok: false, error: 'no-element' };
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    try {
      if (typeof el.click === 'function') {
        el.click();
        await delay(CLICK_SETTLE_MS);
        return { ok: true, method: 'el.click' };
      }
    } catch (e) {}
    try {
      const evNames = ['mouseover','mousemove','mousedown','mouseup','click'];
      for (const t of evNames) {
        const ev = new MouseEvent(t, { bubbles: true, cancelable: true, view: window });
        el.dispatchEvent(ev);
      }
      await delay(CLICK_SETTLE_MS);
      return { ok: true, method: 'dispatch-mouse' };
    } catch (e) {}
    try {
      const r = el.getBoundingClientRect();
      const cx = Math.round(r.left + r.width/2);
      const cy = Math.round(r.top + r.height/2);
      const topEl = document.elementFromPoint(cx, cy) || el;
      const evNames2 = ['pointerover','pointerenter','pointermove','pointerdown','pointerup','click'];
      for (const t of evNames2) {
        const ev = new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, clientX: cx, clientY: cy, isPrimary: true });
        topEl.dispatchEvent(ev);
      }
      await delay(CLICK_SETTLE_MS);
      return { ok: true, method: 'elementFromPoint' };
    } catch (e) {}
    try {
      el.setAttribute && el.setAttribute('tabindex', '-1');
      el.focus && el.focus();
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      await delay(CLICK_SETTLE_MS);
      return { ok: true, method: 'keyboard-enter' };
    } catch (e) {}
    return { ok: false, error: 'click_failed' };
  }

  // ---------- clickNextOnce (guarded) ----------
  async function clickNextOnce({ initialWait = false, jobId = null } = {}) {
    try {
      if (initialWait) {
        const ms = Math.floor(Math.random() * (EASY_AFTER_WAIT_MAX - EASY_AFTER_WAIT_MIN + 1)) + EASY_AFTER_WAIT_MIN;
        console.log('CS: initial wait after Easy Apply:', ms, 'ms');
        await delay(ms);
      }

      const okToProceed = await ensureNoErrorBeforeClick({ jobId });
      if (!okToProceed) return { ok: false, reason: 'aborted_before_click_due_to_form_close_or_error' };

      const nextInfo = findNextCandidate();
      if (!nextInfo) {
        console.log('CS: clickNextOnce - no Next found');
        return { ok: true, reason: 'no_next_found' };
      }

      let nextEl = nextInfo.el || nextInfo;
      if (!isVisible(nextEl)) {
        console.log('CS: next candidate not visible');
        try { await scrollModalToBottom(); console.log('CS: attempted scroll because next not visible (clickNextOnce)'); } catch (e) {}
        if (!isVisible(nextEl)) return { ok: true, reason: 'next_not_visible' };
      }
      if (nextEl.disabled || nextEl.getAttribute && nextEl.getAttribute('aria-disabled') === 'true') {
        console.log('CS: next candidate disabled');
        return { ok: false, reason: 'next_disabled' };
      }

      console.log('CS: clicking Next (reason:', nextInfo.reason || 'unknown', ')', 'desc=', elementDescriptor(nextEl));
      clickHistory.push({ type: 'next', desc: elementDescriptor(nextEl), timestamp: new Date().toISOString() });
      const cr = await robustClick(nextEl);
      if (!cr.ok) {
        console.warn('CS: clickNextOnce - click failed', cr);
        return { ok: false, error: 'click_failed', detail: cr };
      }

      try { await scrollModalToBottom(); console.log('CS: scroll after Next click performed'); } catch (e) { console.warn('CS: scroll after Next click failed', e); }

      if (isErrorIconVisible()) {
        console.log('CS: error icon detected after Next click - waiting until it clears (infinite)');
        clickHistory.push({ type: 'error_icon_detected', desc: elementDescriptor(nextEl), timestamp: new Date().toISOString() });
        const cleared = await waitForErrorIconClearForever({ jobId });
        if (!cleared) {
          console.warn('CS: wait aborted because form disappeared while waiting');
          return { ok: false, reason: 'form_disappeared_while_waiting', clickHistory };
        }
        console.log('CS: error cleared after Next click; waiting post-clear', ERROR_ICON_POST_CLEAR_WAIT_MS, 'ms');
        await delay(ERROR_ICON_POST_CLEAR_WAIT_MS);
        try { await scrollModalToBottom(); console.log('CS: scroll after Next error-clear performed'); } catch (e) { console.warn('CS: scroll after Next error-clear failed', e); }
      }

      await delay(AFTER_NEXT_WAIT_MS);
      return { ok: true, reason: 'next_clicked' };
    } catch (e) {
      console.error('CS: clickNextOnce exception', e);
      return { ok: false, error: String(e) };
    }
  }

  // ---------- clickReviewWithSleep ----------
  async function clickReviewWithSleep({ jobId = null } = {}) {
    try {
      const okToProceed = await ensureNoErrorBeforeClick({ jobId });
      if (!okToProceed) return { ok: false, reason: 'aborted_before_click_due_to_form_close_or_error' };

      const reviewInfo = findAndCheckReviewButton();
      if (!reviewInfo.exists || !reviewInfo.el) {
        console.log('CS: clickReviewWithSleep - Review not found');
        return { ok: false, error: 'review_not_found' };
      }
      if (!reviewInfo.clickable) {
        console.log('CS: review not clickable');
        return { ok: false, error: 'review_not_clickable' };
      }
      console.log('CS: clicking Review', elementDescriptor(reviewInfo.el));
      clickHistory.push({ type: 'review', desc: elementDescriptor(reviewInfo.el), timestamp: new Date().toISOString(), reason: reviewInfo.reason });
      const cr = await robustClick(reviewInfo.el);
      if (!cr.ok) {
        console.warn('CS: clickReviewWithSleep - click failed', cr);
        return { ok: false, error: 'click_failed', detail: cr };
      }

      try { await scrollModalToBottom(); console.log('CS: scroll after Review click performed'); } catch (e) { console.warn('CS: scroll after Review click failed', e); }

      if (isErrorIconVisible()) {
        console.log('CS: error icon detected after Review click - waiting until it clears (infinite)');
        clickHistory.push({ type: 'error_icon_detected_review', desc: elementDescriptor(reviewInfo.el), timestamp: new Date().toISOString() });
        const cleared = await waitForErrorIconClearForever({ jobId });
        if (!cleared) {
          console.warn('CS: wait aborted because form disappeared while waiting (review)');
          return { ok: false, reason: 'form_disappeared_while_waiting_review', clickHistory };
        }
        console.log('CS: error cleared after Review click; waiting post-clear', ERROR_ICON_POST_CLEAR_WAIT_MS, 'ms');
        await delay(ERROR_ICON_POST_CLEAR_WAIT_MS);
        try { await scrollModalToBottom(); console.log('CS: scroll after Review error-clear performed'); } catch (e) { console.warn('CS: scroll after Review error-clear failed', e); }
      }

      await delay(AFTER_REVIEW_TO_SUBMIT_WAIT_MS);
      return { ok: true, reason: 'review_clicked' };
    } catch (e) {
      console.error('CS: clickReviewWithSleep exception', e);
      return { ok: false, error: String(e) };
    }
  }

  // ---------- findSubmitButton wrapper ----------
  function findSubmitButton() {
    return findSubmitCandidate();
  }

  function waitForDomChange(timeout = 10000) {
    return new Promise((resolve) => {
      let resolved = false;
      const to = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          obs.disconnect();
          resolve(false);
        }
      }, timeout);
      const obs = new MutationObserver((mutations) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(to);
          obs.disconnect();
          resolve(true);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  }

  // ---------- MAIN flow with clearer button-priority (Review -> Next -> Submit) ----------
  async function runApplySequence(job) {
    if (window.__cs_running) {
      console.log('CS: runApplySequence already running — ignoring duplicate request');
      return { applied: false, reason: 'already_running' };
    }
    window.__cs_running = true;

    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['__cs_waiting_job','__cs_waiting_since'], (items) => {
          if (items && items.__cs_waiting_job) {
            console.log('CS: resume hint - storage shows waiting job:', items.__cs_waiting_job, 'since', items.__cs_waiting_since);
          }
        });
      }
    } catch (e) {}

    const startTs = Date.now();
    try {
      console.log('CS: runApplySequence starting for job', job && job.jobId);

      const easy = findEasyApplyButton();
      if (!easy) {
        console.log('CS: Easy Apply not found, skipping job', job && job.jobId);
        return { applied: false, reason: 'easy_apply_not_found', jobId: job && job.jobId, clickHistory };
      }

      console.log('CS: clicking Easy Apply', elementDescriptor(easy));
      clickHistory.push({ type: 'easy_apply', desc: elementDescriptor(easy), timestamp: new Date().toISOString() });
      const ce = await robustClick(easy);
      if (!ce.ok) {
        console.warn('CS: easy apply click failed', ce);
        return { applied: false, reason: 'easy_apply_click_failed', detail: ce, clickHistory };
      }
      const initialWait = Math.floor(Math.random() * (EASY_AFTER_WAIT_MAX - EASY_AFTER_WAIT_MIN + 1)) + EASY_AFTER_WAIT_MIN;
      console.log('CS: waiting after Easy Apply:', initialWait, 'ms');
      await delay(initialWait);

      console.log('CS: scrolling modal to bottom after opening Easy Apply');
      try { await scrollModalToBottom(); } catch (e) { console.warn('CS: scroll after open failed', e); }

      console.log('CS: performing first Next attempt');
      try {
        await clickNextOnce({ initialWait: false, jobId: job && job.jobId });
      } catch (e) {
        console.warn('CS: first clickNextOnce failed', e);
      }
      await delay(250);

      let step = 0;
      while (true) {
        step++;
        if (step > MAX_PROGRESS_STEPS || (Date.now() - startTs) > FLOW_TIMEOUT_MS) {
          console.warn('CS: progression aborted - max steps or timeout reached', { step, elapsedMs: Date.now() - startTs });
          return { applied: false, reason: 'progression_timeout_or_max_steps', step, clickHistory };
        }
        console.log('CS: progression loop step', step);

        try { await scrollModalToBottom(); } catch (e) { console.warn('CS: scroll at loop start failed', e); }

        if (isErrorIconVisible()) {
          console.log('CS: progression - detected error icon; waiting before scanning for buttons');
          const cleared = await waitForErrorIconClearForever({ jobId: job && job.jobId });
          if (!cleared) {
            console.warn('CS: progression - form disappeared while waiting for error to clear');
            return { applied: false, reason: 'form_disappeared_while_waiting', clickHistory };
          }
          console.log('CS: progression - error cleared; waiting post-clear', ERROR_ICON_POST_CLEAR_WAIT_MS, 'ms');
          await delay(ERROR_ICON_POST_CLEAR_WAIT_MS);
    
          try { await scrollModalToBottom(); console.log('CS: scroll after progression error-clear performed'); } catch (e) { console.warn('CS: scroll after progression error-clear failed', e); }
        }
        try {
          const reviewInfo = findAndCheckReviewButton();
          if (reviewInfo.exists && reviewInfo.el && reviewInfo.clickable) {
            console.log('CS: Review found -> clicking Review', elementDescriptor(reviewInfo.el));
            const rvres = await clickReviewWithSleep({ jobId: job && job.jobId });
            if (!rvres.ok) {
              console.warn('CS: review_click_failed', rvres);
              return { applied: false, reason: 'review_click_failed', step, detail: rvres, clickHistory };
            }
            await delay(250);
            continue;
          }
        } catch (e) {
          console.warn('CS: error while checking/clicking Review', e);
        }

        try {
          const nextInfo = findNextCandidate();
          if (nextInfo && nextInfo.el) {
            const nextEl = nextInfo.el;
            if (nextEl.disabled || (nextEl.getAttribute && nextEl.getAttribute('aria-disabled') === 'true')) {
              console.log('CS: Next found but disabled -> wait for DOM change and re-check');
              await Promise.race([waitForDomChange(3000), delay(POLL_DELAY_MS)]);
              continue;
            }
            console.log('CS: Next found -> clicking Next', elementDescriptor(nextEl));
            const r = await clickNextOnce({ initialWait: false, jobId: job && job.jobId });
            if (!r.ok) {
              console.warn('CS: next_loop_failed', r);
              await delay(250);
              continue;
            }
            await Promise.race([waitForDomChange(2500), delay(AFTER_NEXT_WAIT_MS)]);
            continue;
          }
        } catch (e) {
          console.warn('CS: error while checking/clicking Next', e);
        }

        try {
          const submitBtn = findSubmitButton();
          if (submitBtn) {
            console.log('CS: Submit button found -> ensure no error then click submit', elementDescriptor(submitBtn));
            const okToClickSubmit = await ensureNoErrorBeforeClick({ jobId: job && job.jobId });
            if (!okToClickSubmit) {
              console.warn('CS: aborted submit click because form disappeared or error persisted');
              return { applied: false, reason: 'aborted_before_submit', clickHistory };
            }
            try { await scrollModalToBottom(); console.log('CS: scroll before submit performed'); } catch (e) { console.warn('CS: scroll before submit failed', e); }
            clickHistory.push({ type: 'submit', desc: elementDescriptor(submitBtn), timestamp: new Date().toISOString() });
            const sc = await robustClick(submitBtn);
            if (!sc.ok) {
              console.warn('CS: submit_click_failed', sc);
              return { applied: false, reason: 'submit_click_failed', step, detail: sc, clickHistory };
            }
            console.log('CS: clicked submit, waiting', AFTER_SUBMIT_WAIT_MS, 'ms');
            try { await scrollModalToBottom(); } catch (e) {}
            await delay(AFTER_SUBMIT_WAIT_MS);
            return { applied: true, reason: 'submitted', step, clickHistory };
          }
        } catch (e) {
          console.warn('CS: error while checking/clicking Submit', e);
        }

        console.log('CS: Neither Review, Next nor Submit found at step', step, ' -> waiting/polling');
        const changed = await waitForDomChange(3000);
        if (!changed) {
          await delay(POLL_DELAY_MS);
        }
      }

    } catch (e) {
      console.error('CS: runApplySequence exception', e);
      return { applied: false, reason: 'exception', error: String(e), clickHistory };
    } finally {
      window.__cs_running = false;
    }
  }

  try {
    window.__cs_helpers = window.__cs_helpers || {};
    Object.assign(window.__cs_helpers, {
      findErrorContainerCandidate, isErrorIconVisible, waitForErrorIconClearForever, ensureNoErrorBeforeClick,
      findEasyApplyButton, findNextCandidate, findReviewCandidate, findAndCheckReviewButton,
      clickNextOnce, clickReviewWithSleep, robustClick, runApplySequence, clickHistory, scrollModalToBottom
    });
  } catch (e) {}

})();
