// // popup.js — require selection every time; no auto-restore of previous selection
// document.addEventListener('DOMContentLoaded', () => {
//   const startBtn = document.getElementById('startBtn');
//   const stopBtn = document.getElementById('stopBtn');
//   const debugBtn = document.getElementById('debugBtn');
//   const previewBtn = document.getElementById('previewBtn');
//   const statusBox = document.getElementById('statusBox');
//   const statusText = document.getElementById('statusText');
//   const jobsEl = document.getElementById('jobs');

//   const candidateSelect = document.getElementById('candidateSelect');
//   const employeeSelect = document.getElementById('employeeSelect');
//   const exportBtn = document.getElementById('exportBtn');

//   let running = false;

//   function setStatus(text, mode = 'idle') {
//     statusText.textContent = text;
//     statusBox.classList.remove('processing','success','error');
//     if (mode === 'processing') statusBox.classList.add('processing');
//     if (mode === 'success') statusBox.classList.add('success');
//     if (mode === 'error') statusBox.classList.add('error');
//   }

//   function setBusy(isBusy) {
//     running = !!isBusy;
//     startBtn.disabled = running;
//     stopBtn.disabled = !running;
//     debugBtn.disabled = running;
//     previewBtn.disabled = running;
//     candidateSelect.disabled = running;
//     employeeSelect.disabled = running;
//     if (running) {
//       setStatus('Running — opening jobs...', 'processing');
//     } else {
//       setStatus('Status: Idle', 'idle');
//     }
//   }

//   // Populate selects from config file (keep placeholder option)
//   fetch(chrome.runtime.getURL('config/config.json'))
//     .then(r => r.json())
//     .then(cfg => {
//       // clear any existing non-placeholder options
//       Array.from(candidateSelect.querySelectorAll('option')).forEach(opt => {
//         if (opt.value !== '') opt.remove();
//       });
//       Array.from(employeeSelect.querySelectorAll('option')).forEach(opt => {
//         if (opt.value !== '') opt.remove();
//       });

//       (cfg.candidates || []).forEach(c => {
//         const opt = document.createElement('option');
//         opt.value = c.id;
//         opt.textContent = `${c.name} (id:${c.id})`;
//         candidateSelect.appendChild(opt);
//       });

//       (cfg.employees || []).forEach(e => {
//         const opt = document.createElement('option');
//         opt.value = e.id;
//         opt.textContent = `${e.name} (id:${e.id})`;
//         employeeSelect.appendChild(opt);
//       });

//       // IMPORTANT: Do NOT restore any previous selection here.
//       // Always keep placeholders selected so the user must actively choose each time.
//       candidateSelect.value = '';
//       employeeSelect.value = '';
//     })
//     .catch(err => {
//       setStatus('Failed loading config: ' + err, 'error');
//       console.error(err);
//     });

//   // Listen for background forwarded messages
//   chrome.runtime.onMessage.addListener((msg) => {
//     if (msg.from === 'background') {
//       if (msg.type === 'progress') {
//         setStatus(msg.text, 'processing');
//       } else if (msg.type === 'done') {
//         setStatus('✅ Completed', 'success');
//         setTimeout(()=>setStatus('Status: Idle', 'idle'), 2500);
//         setBusy(false);
//       } else if (msg.type === 'error') {
//         setStatus('❌ ' + msg.text, 'error');
//         setTimeout(()=>setStatus('Status: Idle', 'idle'), 3000);
//         setBusy(false);
//       }
//     }
//   });

//   // START: validate selections (required every time)
//   startBtn.addEventListener('click', () => {
//     if (running) return;
//     const candidate_val = candidateSelect.value;
//     const employee_val = employeeSelect.value;

//     if (!candidate_val || !employee_val) {
//       setStatus('⚠️ Please select both candidate and employee before starting', 'error');
//       setTimeout(()=> setStatus('Status: Idle', 'idle'), 3000);
//       return;
//     }

//     const candidate_id = Number(candidate_val);
//     const employee_id = Number(employee_val);

//     // Save for content script/background (only for the duration of this run)
//     chrome.storage.local.set({ currentSelection: { candidate_id, employee_id, startedAt: Date.now() } }, () => {
//       setBusy(true);
//       chrome.runtime.sendMessage({ action: 'startApply', candidate_id, employee_id }, (resp) => {
//         if (chrome.runtime.lastError) {
//           setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
//           setBusy(false);
//           console.error(chrome.runtime.lastError);
//           return;
//         }
//         setStatus(resp?.message || 'Started', 'processing');
//       });
//     });
//   });

//   // STOP button
//   stopBtn.addEventListener('click', () => {
//     chrome.runtime.sendMessage({ action: 'stopApply' }, (resp) => {
//       if (chrome.runtime.lastError) {
//         setStatus('Error stopping: ' + chrome.runtime.lastError.message, 'error');
//         console.error(chrome.runtime.lastError);
//         return;
//       }
//       setStatus(resp?.message || 'Stopped', 'idle');
//       setBusy(false);
//       // Clear selection in popup UI so next start requires re-select
//       candidateSelect.value = '';
//       employeeSelect.value = '';
//     });
//   });

//   // Debug: load jobs list
//   debugBtn.addEventListener('click', () => {
//     if (running) return;
//     setStatus('Loading jobs for preview...', 'processing');
//     chrome.runtime.sendMessage({ action: 'debugLoadJobs' }, (resp) => {
//       if (chrome.runtime.lastError) {
//         setStatus('Failed to load jobs: ' + chrome.runtime.lastError.message, 'error');
//         console.error(chrome.runtime.lastError);
//         return;
//       }
//       if (!resp || !resp.jobs) {
//         setStatus(resp?.message || 'No jobs returned', 'error');
//         return;
//       }
//       renderJobs(resp.jobs);
//       setStatus(`Loaded ${resp.count} jobs`, 'success');
//       setTimeout(()=>setStatus('Status: Idle', 'idle'), 1800);
//     });
//   });

//   previewBtn.addEventListener('click', () => debugBtn.click());

//   function renderJobs(jobs) {
//     jobsEl.innerHTML = '';
//     if (!jobs || jobs.length === 0) {
//       jobsEl.innerHTML = '<div class="small">No jobs found in easyapply_today.json</div>';
//       return;
//     }
//     for (const j of jobs) {
//       const jobDiv = document.createElement('div');
//       jobDiv.className = 'job';
//       const left = document.createElement('div');
//       left.className = 'jmeta';
//       const t = document.createElement('div'); t.className = 'jtitle'; t.textContent = j.title || '(no title)';
//       const c = document.createElement('div'); c.className = 'jcomp'; c.textContent = j.company ? `${j.company} • ${j.location || ''}` : (j.location || '');
//       left.appendChild(t); left.appendChild(c);
//       const right = document.createElement('div');
//       const id = document.createElement('div'); id.className = 'jid'; id.textContent = `#${j.jobId}`;
//       right.appendChild(id);
//       jobDiv.appendChild(left); jobDiv.appendChild(right);
//       jobsEl.appendChild(jobDiv);
//     }
//   }

//   // EXPORT button: manual export of global applied_log (unchanged)
//   exportBtn.addEventListener('click', () => {
//     chrome.runtime.sendMessage({ action: 'exportLog' }, (resp) => {
//       if (chrome.runtime.lastError) {
//         setStatus('Export failed: ' + chrome.runtime.lastError.message, 'error');
//         console.error(chrome.runtime.lastError);
//         return;
//       }
//       setStatus('Export requested', 'success');
//       setTimeout(()=>setStatus('Status: Idle', 'idle'), 1200);
//     });
//   });

//   // initial state
//   setStatus('Status: Idle', 'idle');
// });


// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const debugBtn = document.getElementById('debugBtn');
  const previewBtn = document.getElementById('previewBtn');
  const statusText = document.getElementById('statusText');
  const jobsEl = document.getElementById('jobs');
  const candidateSelect = document.getElementById('candidateSelect');
  const employeeSelect = document.getElementById('employeeSelect');

  let running = false;

  function setStatus(text) { statusText.textContent = text; }
  function setBusy(b) {
    running = !!b;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    candidateSelect.disabled = running;
    employeeSelect.disabled = running;
    setStatus(running ? 'Running — opening jobs...' : 'Status: Idle');
  }

  // populate candidate and employee selects
  Promise.all([
    fetch(chrome.runtime.getURL('config/candidates.json')).then(r => r.json()).catch(()=>[]),
    fetch(chrome.runtime.getURL('config/employees.json')).then(r => r.json()).catch(()=>[])
  ]).then(([candidates, employees]) => {
    (candidates||[]).forEach(c => {
      const opt = document.createElement('option'); opt.value = c.id; opt.textContent = `${c.name} (id:${c.id})`; candidateSelect.appendChild(opt);
    });
    (employees||[]).forEach(e => {
      const opt = document.createElement('option'); opt.value = e.id; opt.textContent = `${e.name} (id:${e.id})`; employeeSelect.appendChild(opt);
    });
  });

  // listen to background progress messages
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.from === 'background') {
      if (msg.type === 'progress') setStatus(msg.text);
      if (msg.type === 'done') { setStatus('✅ Completed'); setBusy(false); }
      if (msg.type === 'error') { setStatus('❌ ' + msg.text); setBusy(false); }
    }
  });

  // start button
  startBtn.addEventListener('click', () => {
    if (running) return;

    const candidate_val = candidateSelect.value;
    const employee_val = employeeSelect.value;
    if (!candidate_val || !employee_val) {
      setStatus('⚠️ Please select both candidate and employee before starting');
      setTimeout(()=>setStatus('Status: Idle'),3000);
      return;
    }

    const candidate_id = Number(candidate_val);
    const employee_id = Number(employee_val);

    // store selection and call background start
    chrome.storage.local.set({ currentSelection: { candidate_id, employee_id, startedAt: Date.now() } }, () => {
      setBusy(true);
      chrome.runtime.sendMessage({ action: 'startApply', candidate_id, employee_id }, (resp) => {
        if (chrome.runtime.lastError) {
          setStatus('Error: ' + chrome.runtime.lastError.message);
          setBusy(false);
        } else {
          setStatus(resp?.message || 'Start accepted');
        }
      });
    });
  });

  // stop button
  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopApply' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus('Error stopping: ' + chrome.runtime.lastError.message);
      } else {
        setStatus(resp?.message || 'Stopping');
      }
      // set UI back to idle
      setBusy(false);
      // reset selection in UI (we keep currentSelection in storage so finalize can attribute)
      candidateSelect.value = '';
      employeeSelect.value = '';
    });
  });

  // debug load jobs
  debugBtn.addEventListener('click', () => {
    if (running) return;
    setStatus('Loading jobs for preview...');
    chrome.runtime.sendMessage({ action: 'debugLoadJobs' }, (resp) => {
      if (chrome.runtime.lastError) { setStatus('Failed: ' + chrome.runtime.lastError.message); return; }
      if (!resp || !resp.jobs) { setStatus(resp?.message || 'No jobs returned'); return; }
      renderJobs(resp.jobs);
      setStatus(`Loaded ${resp.count} jobs`);
      setTimeout(()=>setStatus('Status: Idle'),1800);
    });
  });
  previewBtn.addEventListener('click', () => debugBtn.click());

  function renderJobs(jobs) {
    jobsEl.innerHTML = '';
    if (!jobs || jobs.length === 0) { jobsEl.innerHTML = '<div class="small">No jobs found</div>'; return; }
    for (const j of jobs) {
      const jobDiv = document.createElement('div');
      jobDiv.style.padding='6px';
      jobDiv.style.borderBottom='1px solid rgba(255,255,255,0.04)';
      jobDiv.textContent = `${j.title || '(no title)'} — ${j.company || ''} (#${j.jobId})`;
      jobsEl.appendChild(jobDiv);
    }
  }

  // initial UI state
  setStatus('Status: Idle');
});
