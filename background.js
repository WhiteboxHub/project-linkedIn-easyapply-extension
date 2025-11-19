// background.js
importScripts('storage_crypto.js');

let running = false;
let currentIndex = 0;
let jobs = [];

// Map of tabId -> { resolveReady, readyPromise } for content script handshake
const tabReadyMap = new Map();

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('BG: received message', msg);
  // Content script ready handshake
  if (msg && msg.action === 'contentScriptReady' && sender && sender.tab && sender.tab.id) {
    const entry = tabReadyMap.get(sender.tab.id);
    console.log('BG: contentScriptReady from tab', sender.tab.id, 'entry?', !!entry);
    if (entry && entry.resolveReady) {
      entry.resolveReady();
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'encryptAndStore') {
    (async () => {
      try {
        const ab = await encryptCredentials(msg.password, msg.passphrase);
        const b64 = _sc_arrayBufferToBase64(ab);
        await chrome.storage.local.set({ linkedin_user: msg.username, linkedin_pass_enc: b64 });
        console.log('BG: stored encrypted credentials for', msg.username);
        sendResponse({ message: 'Credentials encrypted & stored.' });
      } catch (e) {
        console.error('BG: encrypt/store failed', e);
        sendResponse({ message: 'Encryption failed: ' + (e.message || e) });
      }
    })();
    return true; // async
  }

  if (msg.action === 'startApply') {
    if (running) { sendResponse({ message: 'Already running' }); return; }
    running = true;
    (async () => {
      try {
        await startApplyFlow(msg.passphrase);
        console.log('BG: startApplyFlow finished normally');
      } catch (e) {
        console.error('BG: startApplyFlow error', e);
      } finally {
        running = false;
      }
    })();
    sendResponse({ message: 'Start accepted' });
    return true; // async
  }

  if (msg.action === 'stopApply') {
    running = false;
    sendResponse({ message: 'Stopping' });
    return;
  }

  if (msg.action === 'debugLoadJobs') {
    (async () => {
      try {
        const data = await loadJobs();
        sendResponse({ message: 'Jobs loaded', count: data.length, jobs: data });
      } catch (e) {
        sendResponse({ message: 'Failed to load jobs: ' + e.message });
      }
    })();
    return true;
  }

  sendResponse({ message: 'Unknown action' });
  return false;
});

async function loadJobs() {
  const url = chrome.runtime.getURL('easyapply_today.json');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to fetch jobs JSON: ' + resp.status);
  const data = await resp.json();
  return data;
}

async function createTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => resolve(tab));
  });
}

function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function listener(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      } else if (Date.now() - start > timeout) {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}


function sendMessageToTab(tabId, message, timeout = 120000) { 
  return new Promise((resolve, reject) => {
    let responded = false;
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        responded = true;
        const err = chrome.runtime.lastError;
        if (err) {
          return reject(err);
        }
        resolve(resp);
      });
    } catch (e) {
      return reject(e);
    }

    setTimeout(() => {
      if (!responded) {
        reject(new Error('sendMessage timeout after ' + timeout + 'ms'));
      }
    }, timeout);
  });
}

async function waitForContentScriptReady(tabId, timeout = 10000) {
  if (tabReadyMap.has(tabId)) {
    return tabReadyMap.get(tabId).readyPromise;
  }
  let resolveReady;
  const readyPromise = new Promise((res) => { resolveReady = res; });
  tabReadyMap.set(tabId, { resolveReady, readyPromise });

  const timed = await Promise.race([
    readyPromise.then(() => ({ ok: true })),
    (async () => { await delay(timeout); return { ok: false }; })()
  ]);

  tabReadyMap.delete(tabId);
  return timed.ok;
}

async function startApplyFlow(passphrase) {
  console.log('BG: startApplyFlow beginning');
  try {
    jobs = await loadJobs();
    console.log('BG: loaded jobs count=', jobs.length);
  } catch (e) {
    console.error('BG: loadJobs failed', e);
    running = false;
    return;
  }

  try {
    const stored = await chrome.storage.local.get(['linkedin_user', 'linkedin_pass_enc']);
    if (stored?.linkedin_pass_enc) {
      try {
        const plain = await decryptCredentials(stored.linkedin_pass_enc, passphrase);
        console.log('BG: decrypted LinkedIn password length:', plain.length);
      } catch (e) {
        console.warn('BG: decrypt failed (wrong passphrase?)', e);
      }
    } else {
      console.log('BG: no stored encrypted password found');
    }
  } catch (e) {
    console.warn('BG: error checking storage', e);
  }

  currentIndex = 0;


  const POST_APPLY_WAIT_MS = 25000; 

  while (running && currentIndex < jobs.length) {
    const job = jobs[currentIndex];
    const progressIndex = currentIndex + 1;
    console.log(`BG: processing job ${progressIndex}/${jobs.length}`, job);
    const jobUrl = `https://www.linkedin.com/jobs/view/${job.jobId}`;

    let tab;
    try {
      tab = await createTab(jobUrl);
      console.log('BG: created tab', tab.id, 'url', jobUrl);
    } catch (e) {
      console.error('BG: createTab failed', e);
      currentIndex++;
      continue;
    }

    await delay(1000);
    const loaded = await waitForTabComplete(tab.id, 15000);
    console.log('BG: waitForTabComplete returned', loaded);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js']
      });
      console.log('BG: injected content_script into tab', tab.id);
    } catch (e) {
      console.error('BG: scripting.executeScript failed', e);
      try { chrome.tabs.remove(tab.id); } catch(e){ }
      currentIndex++;
      continue;
    }

    const ready = await waitForContentScriptReady(tab.id, 10000);
    if (!ready) {
      console.warn('BG: content script did not signal ready in time for tab', tab.id);

    } else {
      console.log('BG: content script signaled ready for tab', tab.id);
    }

    let resp = null;
    try {
      const CONTENT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; 
      resp = await sendMessageToTab(tab.id, { action: 'tryApply', job }, CONTENT_SCRIPT_TIMEOUT_MS);
      console.log('BG: received tryApply response from tab', tab.id, resp);
    } catch (e) {
      console.warn('BG: sendMessage/response error for tab', tab.id, e.message || e);
      try {
        await delay(1000);
        resp = await sendMessageToTab(tab.id, { action: 'tryApply', job }, 120000);
        console.log('BG: retry got response', resp);
      } catch (e2) {
        console.error('BG: retry sendMessage also failed for tab', tab.id, e2.message || e2);
      }
    }

    try {
      if (resp && resp.result && resp.result.applied) {
        console.log(`BG: content script reported applied=true for job ${job.jobId}. Waiting ${POST_APPLY_WAIT_MS}ms before closing tab.`);
        await delay(POST_APPLY_WAIT_MS);
      } else {
        await delay(1000);
      }
    } catch (e) {
      console.warn('BG: post-response wait failed', e);
    }

    try {
      chrome.tabs.remove(tab.id);
      console.log('BG: closed tab', tab.id);
    } catch (e) {
      console.warn('BG: could not close tab', e);
    }

    if (!resp) {
      console.warn(`BG: No response from content script for job ${job.jobId}. See earlier warnings/logs.`);
    } else {
      console.log(`BG: Content script response for job ${job.jobId}:`, resp);
    }

    currentIndex++;
  }

  console.log('BG: startApplyFlow exiting; running=', running, 'currentIndex=', currentIndex);
  running = false;
}
