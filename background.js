// background.js
importScripts('storage_crypto.js'); 

let running = false;
let currentIndex = 0;
let jobs = [];

// Helper delay
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('BG: received message', msg);

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

  // Debug helper: load jobs
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

  // Attempt to decrypt stored password (not required; we use it only for diagnostics here)
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

    // Wait for some (small) time for the page to start loading
    await delay(2500);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content_script.js']
      });
      console.log('BG: injected content_script into tab', tab.id);
    } catch (e) {
      console.error('BG: scripting.executeScript failed', e);
    }

    // Send message to content script and wait a short while for it to run
    chrome.tabs.sendMessage(tab.id, { action: 'tryApply', job }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('BG: sendMessage error (content script may not be ready):', chrome.runtime.lastError.message);
      } else {
        console.log('BG: sendMessage response from content script:', resp);
      }
    });

    // Wait conservatively (adjust if needed). This wait allows the content script to interact.
    await delay(12000);

    // Close the tab if still open
    try {
      chrome.tabs.remove(tab.id);
      console.log('BG: closed tab', tab.id);
    } catch (e) {
      console.warn('BG: could not close tab', e);
    }

    currentIndex++;
  }

  console.log('BG: startApplyFlow exiting; running=', running, 'currentIndex=', currentIndex);
  running = false;
}



