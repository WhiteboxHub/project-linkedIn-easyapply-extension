// popup.js 
document.addEventListener('DOMContentLoaded', () => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const debugBtn = document.getElementById('debugBtn');
  const previewBtn = document.getElementById('previewBtn');
  const statusBox = document.getElementById('statusBox');
  const statusText = document.getElementById('statusText');
  const jobsEl = document.getElementById('jobs');

  let running = false;

  function setStatus(text, mode = 'idle') {
    statusText.textContent = text;
    statusBox.classList.remove('processing','success','error');
    if (mode === 'processing') statusBox.classList.add('processing');
    if (mode === 'success') statusBox.classList.add('success');
    if (mode === 'error') statusBox.classList.add('error');
  }

  function setBusy(isBusy) {
    running = !!isBusy;
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    debugBtn.disabled = running;
    previewBtn.disabled = running;
    if (running) {
      setStatus('Running — opening jobs...', 'processing');
    } else {
      setStatus('Status: Idle', 'idle');
    }
  }

  // Listen for background forwarded messages (optional: background can send progress updates)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.from === 'background') {
      if (msg.type === 'progress') {
        setStatus(msg.text, 'processing');
      } else if (msg.type === 'done') {
        setStatus('✅ Completed', 'success');
        setTimeout(()=>setStatus('Status: Idle', 'idle'), 2500);
        setBusy(false);
      } else if (msg.type === 'error') {
        setStatus('❌ ' + msg.text, 'error');
        setTimeout(()=>setStatus('Status: Idle', 'idle'), 3000);
        setBusy(false);
      }
    }
  });

  startBtn.addEventListener('click', () => {
    if (running) return;
    setBusy(true);
    chrome.runtime.sendMessage({ action: 'startApply' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message, 'error');
        setBusy(false);
        console.error(chrome.runtime.lastError);
        return;
      }
      setStatus(resp?.message || 'Started', 'processing');
    });
  });

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopApply' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus('Error stopping: ' + chrome.runtime.lastError.message, 'error');
        console.error(chrome.runtime.lastError);
        return;
      }
      setStatus(resp?.message || 'Stopped', 'idle');
      setBusy(false);
    });
  });

  // Load jobs for preview
  debugBtn.addEventListener('click', () => {
    if (running) return;
    setStatus('Loading jobs for preview...', 'processing');
    chrome.runtime.sendMessage({ action: 'debugLoadJobs' }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus('Failed to load jobs: ' + chrome.runtime.lastError.message, 'error');
        console.error(chrome.runtime.lastError);
        return;
      }
      if (!resp || !resp.jobs) {
        setStatus(resp?.message || 'No jobs returned', 'error');
        return;
      }
      renderJobs(resp.jobs);
      setStatus(`Loaded ${resp.count} jobs`, 'success');
      setTimeout(()=>setStatus('Status: Idle', 'idle'), 1800);
    });
  });

  // small preview button same as debug
  previewBtn.addEventListener('click', () => debugBtn.click());

  function renderJobs(jobs) {
    jobsEl.innerHTML = '';
    if (!jobs || jobs.length === 0) {
      jobsEl.innerHTML = '<div class="small">No jobs found in easyapply_today.json</div>';
      return;
    }
    for (const j of jobs) {
      const jobDiv = document.createElement('div');
      jobDiv.className = 'job';
      const left = document.createElement('div');
      left.className = 'jmeta';
      const t = document.createElement('div'); t.className = 'jtitle'; t.textContent = j.title || '(no title)';
      const c = document.createElement('div'); c.className = 'jcomp'; c.textContent = j.company ? `${j.company} • ${j.location || ''}` : (j.location || '');
      left.appendChild(t); left.appendChild(c);
      const right = document.createElement('div');
      const id = document.createElement('div'); id.className = 'jid'; id.textContent = `#${j.jobId}`;
      right.appendChild(id);
      jobDiv.appendChild(left); jobDiv.appendChild(right);
      jobsEl.appendChild(jobDiv);
    }
  }

  // initial state
  setStatus('Status: Idle', 'idle');
});
