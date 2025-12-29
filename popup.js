
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const keywordInput = document.getElementById('keyword');
  const locationInput = document.getElementById('location');
  const quickSelect = document.getElementById('quickSelect');
  const fetchBtn = document.getElementById('fetchBtn');
  const stopFetchBtn = document.getElementById('stopFetchBtn');

  const candidateSelect = document.getElementById('candidateSelect');
  const employeeSelect = document.getElementById('employeeSelect');

  const jobsPanelHeader = document.getElementById('jobsCount');
  const jobsListEl = document.getElementById('jobsList');
  const selectAllCb = document.getElementById('selectAll');

  const startApplyBtn = document.getElementById('startApplyBtn');
  const statusText = document.getElementById('statusText');

  // State
  let fetchedJobs = []; // [{ jobId, title, company, location }]
  let isFetching = false;
  let isApplying = false;

  // -- Helpers --
  function setStatus(text) { statusText.textContent = text; }

  // 1. Initial Config Load & Restore State
  Promise.all([
    fetch(chrome.runtime.getURL('config/candidates.json')).then(r => r.json()).catch(() => []),
    fetch(chrome.runtime.getURL('config/employees.json')).then(r => r.json()).catch(() => []),
    chrome.storage.local.get(['fetched_jobs_state', 'selected_candidate', 'selected_employee'])
  ]).then(([cands, emps, data]) => {
    (cands || []).forEach(c => {
      const opt = document.createElement('option'); opt.value = c.id; opt.textContent = `${c.name} (${c.id})`; candidateSelect.appendChild(opt);
    });
    (emps || []).forEach(e => {
      const opt = document.createElement('option'); opt.value = e.id; opt.textContent = `${e.name} (${e.id})`; employeeSelect.appendChild(opt);
    });

    // Restore Selections
    if (data.selected_candidate) candidateSelect.value = data.selected_candidate;
    if (data.selected_employee) employeeSelect.value = data.selected_employee;

    // Restore fetched jobs if available
    if (data.fetched_jobs_state && Array.isArray(data.fetched_jobs_state) && data.fetched_jobs_state.length > 0) {
      fetchedJobs = data.fetched_jobs_state;
      renderJobs(fetchedJobs, false); // false = don't save again
      setStatus(`Restored ${fetchedJobs.length} jobs from previous session.`);
    } else {
      // Auto-load from disk if storage is empty
      chrome.runtime.sendMessage({ action: 'debugLoadJobs' }, (resp) => {
        if (resp && resp.jobs && resp.jobs.length > 0) {
          fetchedJobs = resp.jobs;
          renderJobs(fetchedJobs, false);
          setStatus(`Loaded ${resp.jobs.length} jobs from disk.`);
          toggleFetchUI(false);
        }
      });
    }
  });

  // Save Selections when changed
  candidateSelect.addEventListener('change', () => {
    chrome.storage.local.set({ 'selected_candidate': candidateSelect.value });
  });
  employeeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ 'selected_employee': employeeSelect.value });
  });

  // Quick Select Helper
  quickSelect.addEventListener('change', () => {
    if (quickSelect.value) locationInput.value = quickSelect.value;
  });

  // 2. Fetch Flow
  fetchBtn.addEventListener('click', async () => {
    const kw = keywordInput.value.trim();
    const loc = locationInput.value.trim();
    if (!kw) { setStatus('⚠️ Enter a keyword first'); return; }

    isFetching = true;
    toggleFetchUI(true);
    // Don't clear fetchedJobs, we will merge and deduplicate
    setStatus('Opening LinkedIn Search...');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Navigate
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (k, l) => {
        window.location.href = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(k)}&location=${encodeURIComponent(l)}&f_AL=true&f_TPR=r86400`;
      },
      args: [kw, loc]
    });

    setStatus('Waiting for page load (8s)...');

    // Wait then inject scraper
    setTimeout(async () => {
      setStatus('Scraping jobs... (Click Stop to finish early)');
      // We inject a function that periodically sends messages back to popup
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectLiveScraper
      });
    }, 8000);
  });

  // Stop Fetching
  stopFetchBtn.addEventListener('click', () => {
    // Send message to content script to stop scraping
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { action: 'stopScraping' });
    });
    // The content script will reply with the final list, handled by onMessage
    setStatus('Stopping scraper...');
  });

  function toggleFetchUI(fetching) {
    fetchBtn.classList.toggle('hidden', fetching);
    stopFetchBtn.classList.toggle('hidden', !fetching);
    if (!fetching) {
      startApplyBtn.textContent = fetchedJobs.length > 0 ? `Step 2: Start Applying To ${fetchedJobs.length} Jobs` : 'Step 2: Start Applying';
    }
  }

  // Handle messages from Scraper or Background
  chrome.runtime.onMessage.addListener((msg, sender) => {
    // From Scraper (progress)
    if (msg.type === 'scraper_jobs_update' || msg.type === 'scraper_finished') {
      const newJobs = msg.jobs || [];

      // Merge with existing fetchedJobs and deduplicate by jobId
      const existingMap = new Map();
      fetchedJobs.forEach(j => existingMap.set(j.jobId, j));
      newJobs.forEach(j => existingMap.set(j.jobId, j)); // New jobs overwrite or add

      fetchedJobs = Array.from(existingMap.values());

      // Sorting is handled inside renderJobs
      renderJobs(fetchedJobs);

      if (msg.type === 'scraper_finished') {
        isFetching = false;
        toggleFetchUI(false);
        setStatus(`Fetch Complete. Total: ${fetchedJobs.length} jobs.`);
      } else {
        setStatus(`Merging results... Total: ${fetchedJobs.length}`);
      }
    }

    // From Background (Applying status)
    if (msg.from === 'background') {
      if (msg.type === 'progress') setStatus(msg.text);
      if (msg.type === 'done') { setStatus('✅ Application Run Completed'); isApplying = false; }
      if (msg.type === 'error') { setStatus('❌ ' + msg.text); isApplying = false; }
    }
  });


  // 3. Rendering List
  function renderJobs(list, save = true) {
    // 1. Always sort by jobId descending (most recent first)
    list.sort((a, b) => {
      const idA = String(a.jobId || '0');
      const idB = String(b.jobId || '0');
      // Numerical string comparison (works if lengths are same, otherwise pad)
      return idB.localeCompare(idA, undefined, { numeric: true, sensitivity: 'base' });
    });

    if (save) {
      chrome.storage.local.set({ 'fetched_jobs_state': list });
    }

    jobsListEl.innerHTML = '';
    jobsPanelHeader.textContent = `${list.length} Jobs Found! Verify below:`;

    if (list.length === 0) {
      jobsListEl.innerHTML = `<div style="padding:12px;text-align:center;font-size:12px;opacity:0.6">${isFetching ? 'Scanning...' : 'No jobs found yet.'}</div>`;
      return;
    }

    list.forEach((job, idx) => {
      const row = document.createElement('div');
      row.className = 'job-row';

      const ck = document.createElement('input');
      ck.type = 'checkbox';
      ck.className = 'job-check';
      ck.checked = true; // default checked
      ck.dataset.idx = idx;

      const info = document.createElement('div');
      info.className = 'job-info';

      const title = document.createElement('div');
      title.className = 'job-title';
      title.textContent = job.title;

      const meta = document.createElement('div');
      meta.className = 'job-meta';
      meta.textContent = `${job.company || ''} (${job.jobId})`;

      info.appendChild(title);
      info.appendChild(meta);

      row.appendChild(ck);
      row.appendChild(info);
      jobsListEl.appendChild(row);
    });

    updateApplyButtonCount();
  }

  // Select All Toggle
  selectAllCb.addEventListener('change', () => {
    const checks = document.querySelectorAll('.job-check');
    checks.forEach(c => c.checked = selectAllCb.checked);
    updateApplyButtonCount();
  });

  // Watch individual checks
  jobsListEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('job-check')) {
      updateApplyButtonCount();
    }
  });

  function updateApplyButtonCount() {
    const checkedCount = document.querySelectorAll('.job-check:checked').length;
    startApplyBtn.textContent = `Step 2: Start Applying To ${checkedCount} Jobs`;
  }

  // 4. Start Applying
  startApplyBtn.addEventListener('click', () => {
    if (isApplying) return;
    const cVal = candidateSelect.value;
    const eVal = employeeSelect.value;

    if (!cVal || !eVal) {
      setStatus('⚠️ Please select Candidate & Employee first!');
      return;
    }

    // Filter fetched jobs by checked status
    let jobsToRun = [];
    if (fetchedJobs.length > 0) {
      const checks = document.querySelectorAll('.job-check');
      checks.forEach(ck => {
        if (ck.checked) {
          const idx = parseInt(ck.dataset.idx);
          if (fetchedJobs[idx]) jobsToRun.push(fetchedJobs[idx]);
        }
      });
      if (jobsToRun.length === 0) {
        setStatus('⚠️ No jobs selected!');
        return;
      }
    } else {
      // No fetched jobs, maybe running from file default?
      // user said "stop fetch and include data in easyapply_today.json"
      // We can just support sending empty array and BG falls back, OR warn user.
      // Based on UI text, we fallback if list is empty, but user UI implies "Apply to N jobs".
    }

    isApplying = true;
    startApplyBtn.textContent = 'Running...';

    // 1. Persist to disk via Server (overwrites easyapply_today.json)
    fetch('http://localhost:3000/api/save-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer 12345'
      },
      body: JSON.stringify({ jobs: jobsToRun })
    }).then(r => r.json()).then(d => {
      console.log('Jobs saved to disk:', d);
    }).catch(e => console.warn('Failed to save jobs to disk via server', e));

    // 2. Send to BG
    chrome.runtime.sendMessage({
      action: 'startApply',
      candidate_id: Number(cVal),
      employee_id: Number(eVal),
      jobsList: jobsToRun // Pass the explicit list
    }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        isApplying = false;
      } else {
        setStatus('Started! Check LinkedIn tab.');
      }
    });
  });

});

// --- Injected Scraper Function ---
// This runs in the context of the LinkedIn page
function injectLiveScraper() {
  console.log('[Scraper] Injected.');
  let scraperRunning = true;
  let jobsFound = [];

  // Listener to stop
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'stopScraping') {
      scraperRunning = false;
    }
  });

  const delay = ms => new Promise(r => setTimeout(r, ms));

  async function scrape() {
    let page = 1;

    while (scraperRunning && page < 20) { // Safety limit 20 pages
      const cards = document.querySelectorAll('[data-job-id]');
      let newFound = 0;

      for (const el of cards) {
        try {
          const text = el.innerText.toLowerCase();
          if (!text.includes('easy apply')) continue;

          const jobId = el.setAttribute ? el.getAttribute('data-job-id') : null;
          if (!jobId) continue;

          // Dedupe
          if (jobsFound.some(j => j.jobId === jobId)) continue;

          // Parse
          let title = el.querySelector(".job-card-list__title")?.innerText?.trim()
            || el.querySelector(".artdeco-entity-lockup__title a")?.innerText?.trim() || "Unknown";
          if (title.includes("\n")) title = title.split("\n")[0].trim();

          const company = el.querySelector(".artdeco-entity-lockup__subtitle")?.innerText?.trim() || "";
          const location = el.querySelector(".job-card-container__metadata-wrapper li")?.innerText?.trim() || "";

          jobsFound.push({ jobId, title, company, location });
          newFound++;
        } catch (e) { }
      }

      // Notify popup
      if (newFound > 0) {
        chrome.runtime.sendMessage({ type: 'scraper_jobs_update', jobs: jobsFound });
      }

      // Next Page
      const nextBtn = document.querySelector(`button[aria-label="Page ${page + 1}"]`);
      if (nextBtn) {
        nextBtn.scrollIntoView({ behavior: "instant", block: "center" });
        nextBtn.click();
        page++;
        // Wait for load
        await delay(4000);
      } else {
        console.log('[Scraper] No next page.');
        break;
      }
    }

    // Finished
    chrome.runtime.sendMessage({ type: 'scraper_finished', jobs: jobsFound });
  }

  scrape();
}
