// // background.js

// let running = false;
// let currentIndex = 0;
// let jobs = [];

// // Map of tabId -> { resolveReady, readyPromise } for content script handshake
// const tabReadyMap = new Map();

// function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
//   console.log('BG: received message', msg);

//   // Content script ready handshake
//   if (msg && msg.action === 'contentScriptReady' && sender && sender.tab && sender.tab.id) {
//     const entry = tabReadyMap.get(sender.tab.id);
//     console.log('BG: contentScriptReady from tab', sender.tab.id, 'entry?', !!entry);
//     if (entry && entry.resolveReady) {
//       entry.resolveReady();
//     }
//     sendResponse({ ok: true });
//     return;
//   }

//   // Start apply flow (no credentials, no storage)
//   if (msg.action === 'startApply') {
//     if (running) {
//       sendResponse({ message: 'Already running' });
//       return;
//     }
//     running = true;
//     (async () => {
//       try {
//         await startApplyFlow();
//         console.log('BG: startApplyFlow finished normally');
//       } catch (e) {
//         console.error('BG: startApplyFlow error', e);
//       } finally {
//         running = false;
//       }
//     })();
//     sendResponse({ message: 'Start accepted' });
//     return true; // async
//   }

//   if (msg.action === 'stopApply') {
//     running = false;
//     sendResponse({ message: 'Stopping' });
//     return;
//   }

//   if (msg.action === 'debugLoadJobs') {
//     (async () => {
//       try {
//         const data = await loadJobs();
//         sendResponse({ message: 'Jobs loaded', count: data.length, jobs: data });
//       } catch (e) {
//         sendResponse({ message: 'Failed to load jobs: ' + e.message });
//       }
//     })();
//     return true;
//   }

//   sendResponse({ message: 'Unknown action' });
//   return false;
// });

// async function loadJobs() {
//   const url = chrome.runtime.getURL('easyapply_today.json');
//   const resp = await fetch(url);
//   if (!resp.ok) throw new Error('Failed to fetch jobs JSON: ' + resp.status);
//   const data = await resp.json();
//   return data;
// }

// async function createTab(url) {
//   return new Promise((resolve) => {
//     chrome.tabs.create({ url, active: false }, (tab) => resolve(tab));
//   });
// }

// function waitForTabComplete(tabId, timeout = 15000) {
//   return new Promise((resolve) => {
//     const start = Date.now();
//     function listener(updatedTabId, changeInfo, tab) {
//       if (updatedTabId !== tabId) return;
//       if (changeInfo.status === 'complete') {
//         chrome.tabs.onUpdated.removeListener(listener);
//         resolve(true);
//       } else if (Date.now() - start > timeout) {
//         chrome.tabs.onUpdated.removeListener(listener);
//         resolve(false);
//       }
//     }
//     chrome.tabs.onUpdated.addListener(listener);
//   });
// }

// function sendMessageToTab(tabId, message, timeout = 120000) {
//   return new Promise((resolve, reject) => {
//     let responded = false;
//     try {
//       chrome.tabs.sendMessage(tabId, message, (resp) => {
//         responded = true;
//         const err = chrome.runtime.lastError;
//         if (err) {
//           return reject(err);
//         }
//         resolve(resp);
//       });
//     } catch (e) {
//       return reject(e);
//     }

//     setTimeout(() => {
//       if (!responded) {
//         reject(new Error('sendMessage timeout after ' + timeout + 'ms'));
//       }
//     }, timeout);
//   });
// }

// async function waitForContentScriptReady(tabId, timeout = 10000) {
//   if (tabReadyMap.has(tabId)) {
//     return tabReadyMap.get(tabId).readyPromise;
//   }
//   let resolveReady;
//   const readyPromise = new Promise((res) => { resolveReady = res; });
//   tabReadyMap.set(tabId, { resolveReady, readyPromise });

//   const timed = await Promise.race([
//     readyPromise.then(() => ({ ok: true })),
//     (async () => { await delay(timeout); return { ok: false }; })()
//   ]);

//   tabReadyMap.delete(tabId);
//   return timed.ok;
// }

// async function startApplyFlow() {
//   console.log('BG: startApplyFlow beginning');

//   // Load jobs (from easyapply_today.json)
//   try {
//     jobs = await loadJobs();
//     console.log('BG: loaded jobs count =', jobs.length);
//   } catch (e) {
//     console.error('BG: loadJobs failed', e);
//     running = false;
//     return;
//   }

//   currentIndex = 0;
//   const POST_APPLY_WAIT_MS = 25000;

//   while (running && currentIndex < jobs.length) {
//     const job = jobs[currentIndex];
//     const progressIndex = currentIndex + 1;
//     console.log(`BG: processing job ${progressIndex}/${jobs.length}`, job);
//     const jobUrl = `https://www.linkedin.com/jobs/view/${job.jobId}`;

//     let tab;
//     try {
//       tab = await createTab(jobUrl);
//       console.log('BG: created tab', tab.id, 'url', jobUrl);
//     } catch (e) {
//       console.error('BG: createTab failed', e);
//       currentIndex++;
//       continue;
//     }

//     await delay(1000);
//     const loaded = await waitForTabComplete(tab.id, 15000);
//     console.log('BG: waitForTabComplete returned', loaded);

//     try {
//       await chrome.scripting.executeScript({
//         target: { tabId: tab.id },
//         files: ['content_script.js']
//       });
//       console.log('BG: injected content_script into tab', tab.id);
//     } catch (e) {
//       console.error('BG: scripting.executeScript failed', e);
//       try { chrome.tabs.remove(tab.id); } catch (e2) {}
//       currentIndex++;
//       continue;
//     }

//     const ready = await waitForContentScriptReady(tab.id, 10000);
//     if (!ready) {
//       console.warn('BG: content script did not signal ready in time for tab', tab.id);
//     } else {
//       console.log('BG: content script signaled ready for tab', tab.id);
//     }

//     let resp = null;
//     try {
//       const CONTENT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
//       resp = await sendMessageToTab(tab.id, { action: 'tryApply', job }, CONTENT_SCRIPT_TIMEOUT_MS);
//       console.log('BG: received tryApply response from tab', tab.id, resp);
//     } catch (e) {
//       console.warn('BG: sendMessage/response error for tab', tab.id, e.message || e);
//       try {
//         await delay(1000);
//         resp = await sendMessageToTab(tab.id, { action: 'tryApply', job }, 120000);
//         console.log('BG: retry got response', resp);
//       } catch (e2) {
//         console.error('BG: retry sendMessage also failed for tab', tab.id, e2.message || e2);
//       }
//     }

//     try {
//       if (resp && resp.result && resp.result.applied) {
//         console.log(`BG: content script reported applied=true for job ${job.jobId}. Waiting ${POST_APPLY_WAIT_MS}ms before closing tab.`);
//         await delay(POST_APPLY_WAIT_MS);
//       } else {
//         await delay(1000);
//       }
//     } catch (e) {
//       console.warn('BG: post-response wait failed', e);
//     }

//     try {
//       chrome.tabs.remove(tab.id);
//       console.log('BG: closed tab', tab.id);
//     } catch (e) {
//       console.warn('BG: could not close tab', e);
//     }

//     if (!resp) {
//       console.warn(`BG: No response from content script for job ${job.jobId}. See earlier warnings/logs.`);
//     } else {
//       console.log(`BG: Content script response for job ${job.jobId}:`, resp);
//     }

//     currentIndex++;
//   }

//   console.log('BG: startApplyFlow exiting; running =', running, 'currentIndex =', currentIndex);
//   running = false;
// }



// background.js
// Start/stop run flow + per-run logging and single export per run

let running = false;
let currentIndex = 0;
let jobs = [];
let currentRunId = null; // string run id for the active run

// Map of tabId -> { resolveReady, readyPromise } for content script handshake
const tabReadyMap = new Map();

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

// Storage keys
const STORAGE_KEYS = {
  LOG: 'applied_log',             // all-time cumulative log (array)
  COUNTS: 'counts',               // counts per candidate (object)
  CURRENT_SELECTION: 'currentSelection',
  CONFIG_CACHE: 'configCache',
  CURRENT_RUN_LOG: 'current_run_log', // entries for active run
  CURRENT_RUN_META: 'current_run_meta' // { runId, startedAt }
};

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

  // Start apply flow
  if (msg.action === 'startApply') {
    if (running) {
      sendResponse({ message: 'Already running' });
      return;
    }

    // Candidate/employee must be provided by popup (popup enforces it)
    const candidate_id = msg.candidate_id;
    const employee_id = msg.employee_id;

    if (typeof candidate_id === 'undefined' || typeof employee_id === 'undefined') {
      sendResponse({ message: 'Missing candidate_id or employee_id' });
      return;
    }

    // Save selection for content script to read
    chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_SELECTION]: { candidate_id, employee_id, startedAt: Date.now() } }, () => {
      console.log('BG: saved currentSelection', candidate_id, employee_id);
    });

    // Start a new run session
    startNewRun().then(() => {
      running = true;
      (async () => {
        try {
          await startApplyFlow();
          console.log('BG: startApplyFlow finished normally');
          chrome.runtime.sendMessage({ from: 'background', type: 'done', text: 'Run finished' });
        } catch (e) {
          console.error('BG: startApplyFlow error', e);
          chrome.runtime.sendMessage({ from: 'background', type: 'error', text: String(e) });
        } finally {
          // ensure we export the run results when the run stops (even if stopped early)
          try {
            await finalizeRunAndExport();
          } catch (e) {
            console.error('BG: finalizeRunAndExport failed', e);
          }
          running = false;
        }
      })();
    }).catch(err => {
      console.error('BG: startNewRun failed', err);
    });

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
        const jobsData = Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);
        sendResponse({ message: 'Jobs loaded', count: jobsData.length, jobs: jobsData });
      } catch (e) {
        sendResponse({ message: 'Failed to load jobs: ' + (e && e.message ? e.message : String(e)) });
      }
    })();
    return true;
  }

  // Manual export of global log
  if (msg.action === 'exportLog') {
    exportLog().then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      console.error('BG: exportLog failed', err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }

  // Content script informing a successful submission
  if (msg.type === 'application_submitted') {
    handleSubmission(msg).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      console.error('BG: handleSubmission error', err);
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }

  sendResponse({ message: 'Unknown action' });
  return false;
});

// Load jobs JSON from extension file
async function loadJobs() {
  const url = chrome.runtime.getURL('easyapply_today.json');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Failed to fetch jobs JSON: ' + resp.status);
  const data = await resp.json();
  return Array.isArray(data) ? data : (Array.isArray(data.jobs) ? data.jobs : []);
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

async function startApplyFlow() {
  console.log('BG: startApplyFlow beginning');

  try {
    jobs = await loadJobs();
    console.log('BG: loaded jobs count =', jobs.length);
  } catch (e) {
    console.error('BG: loadJobs failed', e);
    running = false;
    return;
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
      try { chrome.tabs.remove(tab.id); } catch (e2) {}
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
      const CONTENT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
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

  console.log('BG: startApplyFlow exiting; running =', running, 'currentIndex =', currentIndex);
  running = false;
}

// ---- Run lifecycle helpers ----
function genRunId() {
  return `run-${Date.now()}`;
}

async function startNewRun() {
  currentRunId = genRunId();
  const meta = { runId: currentRunId, startedAt: new Date().toISOString() };
  // reset current run log
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.CURRENT_RUN_META]: meta, [STORAGE_KEYS.CURRENT_RUN_LOG]: [] }, () => {
      console.log('BG: started new run', meta);
      resolve();
    });
  });
}

async function finalizeRunAndExport() {
  // read current run meta + log
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEYS.CURRENT_RUN_META, STORAGE_KEYS.CURRENT_RUN_LOG], async (data) => {
      try {
        const meta = data[STORAGE_KEYS.CURRENT_RUN_META] || null;
        const runLog = data[STORAGE_KEYS.CURRENT_RUN_LOG] || [];
        if (!meta) {
          console.log('BG: no active run meta to finalize');
          return resolve();
        }
        // Export only if there are submissions in this run
        if (runLog.length === 0) {
          console.log('BG: run finished but no submissions to export for run', meta.runId);
          // clear current run meta/log
          chrome.storage.local.remove([STORAGE_KEYS.CURRENT_RUN_META, STORAGE_KEYS.CURRENT_RUN_LOG], () => resolve());
          return;
        }

        const exportObj = {
          runId: meta.runId,
          startedAt: meta.startedAt,
          exportedAt: new Date().toISOString(),
          submissions: runLog
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const filename = `easyapply_run_${meta.runId}_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
        const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);

        chrome.downloads.download({
          url,
          filename,
          conflictAction: 'overwrite',
          saveAs: false
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('BG: run export download error', chrome.runtime.lastError);
            // still clear run meta/log to avoid repeated exports later
            chrome.storage.local.remove([STORAGE_KEYS.CURRENT_RUN_META, STORAGE_KEYS.CURRENT_RUN_LOG], () => {
              reject(chrome.runtime.lastError);
            });
          } else {
            console.log('BG: exported run file', filename, downloadId);
            // clear run meta/log
            chrome.storage.local.remove([STORAGE_KEYS.CURRENT_RUN_META, STORAGE_KEYS.CURRENT_RUN_LOG], () => {
              resolve(downloadId);
            });
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ------- Submission logging -------
async function loadConfigCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.CONFIG_CACHE], (data) => {
      if (data && data[STORAGE_KEYS.CONFIG_CACHE]) {
        resolve(data[STORAGE_KEYS.CONFIG_CACHE]);
      } else {
        fetch(chrome.runtime.getURL('config/config.json'))
          .then(r => r.json())
          .then(cfg => {
            chrome.storage.local.set({ [STORAGE_KEYS.CONFIG_CACHE]: cfg }, () => resolve(cfg));
          })
          .catch(() => resolve({ candidates: [], employees: [] }));
      }
    });
  });
}

async function handleSubmission(msg) {
  const cfg = await loadConfigCache();
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEYS.LOG, STORAGE_KEYS.COUNTS, STORAGE_KEYS.CURRENT_RUN_LOG, STORAGE_KEYS.CURRENT_RUN_META], (data) => {
      try {
        const globalLog = data[STORAGE_KEYS.LOG] || [];
        const counts = data[STORAGE_KEYS.COUNTS] || {};
        const runLog = data[STORAGE_KEYS.CURRENT_RUN_LOG] || [];
        const runMeta = data[STORAGE_KEYS.CURRENT_RUN_META] || null;

        const candidate = (cfg.candidates || []).find(c => c.id === msg.candidate_id) || { id: msg.candidate_id, name: 'unknown' };
        const employee = (cfg.employees || []).find(e => e.id === msg.employee_id) || { id: msg.employee_id, name: 'unknown' };

        const entry = {
          candidate_id: candidate.id,
          candidate_name: candidate.name,
          employee_id: employee.id,
          employee_name: employee.name,
          jobInfo: msg.jobInfo || null,
          timestamp: new Date(msg.timestamp).toISOString()
        };

        // append to global log
        globalLog.push(entry);

        // append to current run log
        runLog.push(entry);

        // update counts
        const key = String(candidate.id);
        counts[key] = (counts[key] || 0) + 1;

        // persist
        chrome.storage.local.set({
          [STORAGE_KEYS.LOG]: globalLog,
          [STORAGE_KEYS.COUNTS]: counts,
          [STORAGE_KEYS.CURRENT_RUN_LOG]: runLog
        }, () => {
          // notify popup UI
          const text = `Submitted for candidate ${candidate.name} (id:${candidate.id}). Total: ${counts[key]}`;
          chrome.runtime.sendMessage({ from: 'background', type: 'progress', text });

          console.log('BG: recorded submission for run', runMeta && runMeta.runId, entry);
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Build aggregated JSON for entire global log and trigger download (manual export)
async function exportLog() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEYS.LOG, STORAGE_KEYS.COUNTS], (data) => {
      try {
        const log = data[STORAGE_KEYS.LOG] || [];
        // aggregate per candidate
        const aggregated = {};
        log.forEach(entry => {
          const id = String(entry.candidate_id);
          if (!aggregated[id]) {
            aggregated[id] = {
              candidate_id: entry.candidate_id,
              candidate_name: entry.candidate_name,
              count: 0,
              lastApplied: null
            };
          }
          aggregated[id].count += 1;
          const t = new Date(entry.timestamp);
          if (!aggregated[id].lastApplied || new Date(aggregated[id].lastApplied) < t) {
            aggregated[id].lastApplied = t.toISOString();
          }
        });

        const rows = Object.values(aggregated);

        const exportObj = {
          exportedAt: new Date().toISOString(),
          summary: rows,
          raw: log
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const filename = `easyapply_log_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
        const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);

        chrome.downloads.download({
          url,
          filename,
          conflictAction: 'overwrite',
          saveAs: false
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('Download error', chrome.runtime.lastError);
            reject(chrome.runtime.lastError);
          } else {
            resolve(downloadId);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}
