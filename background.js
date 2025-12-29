// background.js
// Manages run lifecycle, receives submission messages from content script,
// aggregates run log, downloads run JSON on finalize, and POSTs summary to server.

let running = false;
let currentIndex = 0;
let jobs = [];
let currentActiveTabId = null;
const tabReadyMap = new Map();

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

const STORAGE = {
  CURRENT_SELECTION: 'currentSelection',     // { candidate_id, employee_id, startedAt }
  CURRENT_RUN_META: 'current_run_meta',      // { runId, startedAt, selection }
  CURRENT_RUN_LOG: 'current_run_log'         // [ { candidate_id, employee_id, jobInfo, timestamp } ]
};

// Recover unfinished run on service worker start and finalize it
(async function recoverOnStart() {
  try {
    chrome.storage.local.get([STORAGE.CURRENT_RUN_META, STORAGE.CURRENT_RUN_LOG], async (data) => {
      const meta = data[STORAGE.CURRENT_RUN_META];
      const runLog = Array.isArray(data[STORAGE.CURRENT_RUN_LOG]) ? data[STORAGE.CURRENT_RUN_LOG] : [];
      if (meta && runLog.length > 0) {
        console.log('BG: recovered unfinished run on startup; finalizing runId=', meta.runId);
        try { await finalizeRunAndExport(); } catch (e) { console.error('BG: recover finalize error', e); }
      }
    });
  } catch (e) { console.error('BG: recoverOnStart error', e); }
})();

// Stop if the job tab is manually closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (running && tabId === currentActiveTabId) {
    console.log('BG: Active job tab closed manually. Stopping extension.');
    stopApplicationFlow('Job tab closed manually');
  }
});

async function stopApplicationFlow(reason = 'Unknown') {
  if (!running) return;
  console.log(`BG: Stopping application flow. Reason: ${reason}`);
  running = false;
  currentActiveTabId = null;
  try {
    await finalizeRunAndExport();
  } catch (e) {
    console.error('BG: finalize error on stop', e);
  }
  chrome.runtime.sendMessage({ from: 'background', type: 'error', text: `Stopped: ${reason}` });
}

// Heartbeat removed to allow extension to follow user request: "if i stope the server to ity should work only post"
// This means the extension continues even if local server is down, and only syncs at the end.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.action === 'contentScriptReady') {
    if (sender && sender.tab && sender.tab.id) {
      const entry = tabReadyMap.get(sender.tab.id);
      if (entry && entry.resolveReady) entry.resolveReady();
    }
    sendResponse && sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'startApply') {
    (async () => {
      if (running) { sendResponse({ message: 'Already running' }); return; }
      const { candidate_id, employee_id, jobsList } = msg;

      if (!candidate_id || !employee_id) {
        sendResponse({ message: 'Missing selection' }); return;
      }

      const runMeta = { runId: `run-${Date.now()}`, startedAt: new Date().toISOString(), selection: { candidate_id, employee_id } };
      const storageData = {
        [STORAGE.CURRENT_SELECTION]: { candidate_id, employee_id, startedAt: Date.now() },
        [STORAGE.CURRENT_RUN_META]: runMeta,
        [STORAGE.CURRENT_RUN_LOG]: []
      };

      if (Array.isArray(jobsList) && jobsList.length > 0) {
        storageData['current_jobs_list'] = jobsList;
      } else {
        chrome.storage.local.remove('current_jobs_list');
      }

      chrome.storage.local.set(storageData, () => {
        running = true;
        startApplyFlow().catch(e => {
          console.error('BG: startApplyFlow error', e);
          chrome.runtime.sendMessage({ from: 'background', type: 'error', text: String(e) });
        }).finally(() => { running = false; });
      });

      sendResponse({ message: 'Start accepted' });
    })();
    return true;
  }

  if (msg.action === 'stopApply') {
    (async () => {
      await stopApplicationFlow('Stopped by user');
      sendResponse && sendResponse({ message: 'Stopped and exported run' });
    })();
    return true;
  }

  if (msg.action === 'debugLoadJobs') {
    loadJobs().then(data => sendResponse({ message: 'Jobs loaded', count: data.length, jobs: data }))
      .catch(e => sendResponse({ message: 'Failed: ' + String(e) }));
    return true;
  }

  // No-op for application_submitted because it is handled directly by the startApplyFlow loop now.
});

// -------------------- Helpers --------------------

async function loadJobs() {
  const url = chrome.runtime.getURL('easyapply_today.json');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to fetch jobs JSON: ' + resp.status);
  const data = await resp.json();
  const list = Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);
  // Sort descending by jobId
  list.sort((a, b) => {
    const idA = String(a.jobId || '0');
    const idB = String(b.jobId || '0');
    return idB.localeCompare(idA, undefined, { numeric: true, sensitivity: 'base' });
  });
  return list;
}

async function createTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => resolve(tab));
  });
}

function waitForTabComplete(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(true); }
      else if (Date.now() - start > timeout) { chrome.tabs.onUpdated.removeListener(listener); resolve(false); }
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
        if (err) return reject(err);
        resolve(resp);
      });
    } catch (e) { reject(e); }
    setTimeout(() => { if (!responded) reject(new Error('sendMessage timeout')); }, timeout);
  });
}

async function waitForContentScriptReady(tabId, timeout = 10000) {
  if (tabReadyMap.has(tabId)) return tabReadyMap.get(tabId).readyPromise;
  let resolveReady;
  const readyPromise = new Promise(res => { resolveReady = res; });
  tabReadyMap.set(tabId, { resolveReady, readyPromise });
  const timed = await Promise.race([readyPromise.then(() => ({ ok: true })), (async () => { await delay(timeout); return { ok: false }; })()]);
  tabReadyMap.delete(tabId);
  return timed.ok;
}

// -------------------- Main apply loop --------------------
async function startApplyFlow() {
  // Try to load custom jobs from storage first (pushed by popup), otherwise load from file
  const data = await chrome.storage.local.get(['current_jobs_list']);
  if (data && Array.isArray(data.current_jobs_list) && data.current_jobs_list.length > 0) {
    jobs = data.current_jobs_list;
    console.log(`BG: Using ${jobs.length} jobs from manual fetch/selection`);
  } else {
    jobs = await loadJobs().catch(e => { console.error('BG: loadJobs error', e); return []; });
    console.log(`BG: Using ${jobs.length} jobs from easyapply_today.json`);
  }

  currentIndex = 0;
  const POST_APPLY_WAIT_MS = 25000;

  while (running && currentIndex < jobs.length) {
    const job = jobs[currentIndex];
    const jobUrl = `https://www.linkedin.com/jobs/view/${job.jobId}`;
    let tab;
    try {
      tab = await createTab(jobUrl);
      currentActiveTabId = tab.id;
    } catch (e) { console.error('BG: createTab failed', e); currentIndex++; continue; }

    await delay(1000);
    await waitForTabComplete(tab.id, 15000);

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
    } catch (e) {
      console.error('BG: injecting content_script failed', e);
      try { chrome.tabs.remove(tab.id); } catch (_) { }
      currentIndex++;
      continue;
    }

    await waitForContentScriptReady(tab.id, 10000);

    try {
      const CONTENT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
      const resp = await sendMessageToTab(tab.id, { action: 'tryApply', job }, CONTENT_SCRIPT_TIMEOUT_MS).catch(e => { console.warn('BG: tryApply send error', e); return null; });

      if (resp && resp.result && resp.result.applied) {
        console.log(`BG: Job ${job.jobId} marked as applied by content script.`);

        // --- RELIABLE IMMEDIATE SYNC ---
        // Get metadata for current run
        const runData = await chrome.storage.local.get([STORAGE.CURRENT_RUN_META, STORAGE.CURRENT_SELECTION]);
        const meta = runData[STORAGE.CURRENT_RUN_META] || {};
        const sel = runData[STORAGE.CURRENT_SELECTION] || {};
        const cId = Number(sel.candidate_id || 0);
        const eId = Number(sel.employee_id || 0);

        if (cId && eId) {
          try {
            // Load config for names
            let cfg = { candidates: [], employees: [] };
            try {
              cfg.candidates = await fetch(chrome.runtime.getURL('config/candidates.json')).then(r => r.json());
              cfg.employees = await fetch(chrome.runtime.getURL('config/employees.json')).then(r => r.json());
            } catch (e) { }

            const cand = (cfg.candidates || []).find(c => Number(c.id) === cId) || { name: 'unknown' };
            const emp = (cfg.employees || []).find(e => Number(e.id) === eId) || { name: 'unknown' };

            const row = {
              job_id: job.jobId,
              job_name: job.title || 'Unknown Job',
              candidate_id: cId,
              candidate_name: cand.name,
              employee_id: eId,
              employee_name: emp.name,
              activity_date: new Date().toISOString().slice(0, 10),
              activity_count: 1,
              notes: `Applied to ${job.company || 'Unknown Company'} via Extension Loop`,
              last_mod_date: new Date().toISOString()
            };

            console.log(`BG: [QUEUED] Candidate: ${cand.name} | Employee: ${emp.name} | Job: ${job.title} - Will sync on tab close or finish.`);

            // Also record in internal log for finalize stats
            chrome.storage.local.get([STORAGE.CURRENT_RUN_LOG], (data) => {
              const runLog = Array.isArray(data[STORAGE.CURRENT_RUN_LOG]) ? data[STORAGE.CURRENT_RUN_LOG] : [];
              runLog.push({ candidate_id: cId, employee_id: eId, jobInfo: job, timestamp: new Date().toISOString() });
              chrome.storage.local.set({ [STORAGE.CURRENT_RUN_LOG]: runLog });
            });

            chrome.runtime.sendMessage({ from: 'background', type: 'progress', text: `Logged: ${job.title}` });
          } catch (syncErr) {
            console.error('BG: Immediate loop sync failed', syncErr);
          }
        }

        await delay(POST_APPLY_WAIT_MS);
      } else {
        await delay(1000);
      }
    } catch (e) {
      console.warn('BG: tryApply handling error', e);
    }

    try { chrome.tabs.remove(tab.id); } catch (e) { console.warn('BG: could not close tab', e); }

    currentIndex++;
  }

  // run finished normally or stopped by user (running flag may be false)
  try {
    await finalizeRunAndExport();
  } catch (e) {
    console.error('BG: finalizeRunAndExport after loop failed', e);
  } finally {
    running = false;
  }
}

// -------------------- Finalize / Export --------------------
async function finalizeRunAndExport() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE.CURRENT_RUN_META, STORAGE.CURRENT_RUN_LOG], async (data) => {
      try {
        const meta = data[STORAGE.CURRENT_RUN_META] || null;
        const runLog = Array.isArray(data[STORAGE.CURRENT_RUN_LOG]) ? data[STORAGE.CURRENT_RUN_LOG] : [];

        if (!meta) {
          // nothing to export
          return resolve();
        }

        // Load config names for friendly JSON
        let cfg = { candidates: [], employees: [] };
        try {
          cfg.candidates = await fetch(chrome.runtime.getURL('config/candidates.json')).then(r => r.json());
          cfg.employees = await fetch(chrome.runtime.getURL('config/employees.json')).then(r => r.json());
        } catch (e) { console.warn('BG: failed to load config names', e); }

        const sel = meta.selection || {};
        const candidateObj = (cfg.candidates || []).find(c => Number(c.id) === Number(sel.candidate_id)) || { id: sel.candidate_id, name: 'unknown' };
        const employeeObj = (cfg.employees || []).find(e => Number(e.id) === Number(sel.employee_id)) || { id: sel.employee_id, name: 'unknown' };

        // Filter submissions for this candidate (should already match) and prepare export submissions array
        const submissions = (runLog || []).filter(e => Number(e.candidate_id) === Number(sel.candidate_id)).map(e => ({
          jobId: e.jobInfo && e.jobInfo.jobId ? String(e.jobInfo.jobId) : null,
          title: e.jobInfo && e.jobInfo.title ? e.jobInfo.title : null,
          company: e.jobInfo && e.jobInfo.company ? e.jobInfo.company : null,
          timestamp: e.timestamp
        }));

        const exportObj = {
          runId: meta.runId,
          candidate: { id: candidateObj.id, name: candidateObj.name },
          employee: { id: employeeObj.id, name: employeeObj.name },
          startedAt: meta.startedAt,
          exportedAt: new Date().toISOString(),
          submissions
        };

        // --- JSON Download ---
        const jsonContent = JSON.stringify(exportObj, null, 2);
        const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonContent);
        chrome.downloads.download({
          url: dataUrl,
          filename: `run_${meta.runId}_${candidateObj.name.replace(/\s+/g, '_')}.json`,
          saveAs: false
        });

        // --- Server Sync ---
        // POST to localhost:3000/api/job-activity
        try {
          if (submissions.length > 0) {
            const serverRows = submissions.map(s => {
              const d = s.timestamp ? s.timestamp.slice(0, 10) : new Date().toISOString().slice(0, 10);
              return {
                job_id: s.jobId,
                job_name: s.title || 'Unknown Job',
                candidate_id: Number(sel.candidate_id),
                candidate_name: candidateObj.name,
                employee_id: Number(sel.employee_id),
                employee_name: employeeObj.name,
                activity_date: d,
                activity_count: 1,
                notes: `${s.title || 'Unknown Role'} @ ${s.company || 'Unknown Company'}`,
                last_mod_date: new Date().toISOString()
              };
            });
            console.log('BG: Final check sync ' + serverRows.length + ' rows to server...');
            const resp = await fetch('http://localhost:3000/api/job-activity', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer 12345'
              },
              body: JSON.stringify({ rows: serverRows, runId: meta.runId })
            });

            if (resp.ok) {
              console.log('BG: Sync successful');
              // Clear run meta/log ONLY if sync succeeded
              chrome.storage.local.remove([STORAGE.CURRENT_RUN_META, STORAGE.CURRENT_RUN_LOG], () => {
                resolve();
              });
            } else {
              console.error('BG: Sync failed - status:', resp.status);
              resolve(); // Resolve anyway so we don't hang, but storage is kept
            }
          } else {
            // No submissions to sync, safe to clear
            chrome.storage.local.remove([STORAGE.CURRENT_RUN_META, STORAGE.CURRENT_RUN_LOG], () => {
              resolve();
            });
          }
        } catch (serverErr) {
          console.error('BG: Sync error (Server likely down):', serverErr.message);
          resolve(); // Resolve anyway, storage is kept for recovery
        }

      } catch (e) {
        reject(e);
      }
    });
  });
}
