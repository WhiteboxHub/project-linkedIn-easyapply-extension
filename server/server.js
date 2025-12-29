/**
 * server.js
 * Simple Express server to accept run summaries and insert/upsert into job_activity_log.
 * Dev mode: API_KEY may be blank (no auth).
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../output');
// Ensure output dir exists
fs.mkdir(OUTPUT_DIR, { recursive: true }).catch(console.error);

// --- HELPER FUNCTIONS (Local Config Priority) ---

let _CACHED_JOB_TYPE_ID = null;
let _CACHED_EMPLOYEE_ID = null;
let _LOCAL_CANDIDATES = null;
let _LOCAL_EMPLOYEES = null;

async function loadLocalCandidates() {
  if (_LOCAL_CANDIDATES) return _LOCAL_CANDIDATES;
  try {
    const configPath = path.join(__dirname, '../config/candidates.json');
    console.log(`[LOCAL INFO] Loading candidates from: ${configPath}`);
    const data = await fs.readFile(configPath, 'utf-8');
    // Remove potential UTF-8 BOM
    _LOCAL_CANDIDATES = JSON.parse(data.replace(/^\uFEFF/, ''));
    console.log(`[LOCAL INFO] Loaded candidates: ${_LOCAL_CANDIDATES.length}`);
  } catch (e) {
    console.error('[LOCAL ERROR] Could not load candidates.json:', e.message);
    _LOCAL_CANDIDATES = [];
  }
  return _LOCAL_CANDIDATES;
}

async function loadLocalEmployees() {
  if (_LOCAL_EMPLOYEES) return _LOCAL_EMPLOYEES;
  try {
    const configPath = path.join(__dirname, '../config/employees.json');
    const data = await fs.readFile(configPath, 'utf-8');
    _LOCAL_EMPLOYEES = JSON.parse(data.replace(/^\uFEFF/, ''));
    console.log(`[LOCAL INFO] Loaded employees: ${_LOCAL_EMPLOYEES.length}`);
  } catch (e) {
    console.error('[LOCAL ERROR] Could not load employees.json! Error:', e.message);
    _LOCAL_EMPLOYEES = [];
  }
  return _LOCAL_EMPLOYEES;
}

async function fetchInternalEmployeeId(token) {
  if (_CACHED_EMPLOYEE_ID) return _CACHED_EMPLOYEE_ID;
  const emps = await loadLocalEmployees();
  if (emps.length === 0) {
    console.warn('[LOCAL WARNING] No employees loaded from config.');
    return null;
  }
  _CACHED_EMPLOYEE_ID = emps[0].id;
  console.log(`[LOCAL INFO] Using Employee ID: ${_CACHED_EMPLOYEE_ID}`);
  return _CACHED_EMPLOYEE_ID;
}

async function fetchInternalJobTypeId(token) {
  if (_CACHED_JOB_TYPE_ID) return _CACHED_JOB_TYPE_ID;
  try {
    const configPath = path.join(__dirname, '../config/api_config.json');
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data);
    _CACHED_JOB_TYPE_ID = config.default_job_id || 116;
  } catch (e) {
    _CACHED_JOB_TYPE_ID = 116;
  }
  console.log(`[LOCAL INFO] Using Job ID: ${_CACHED_JOB_TYPE_ID}`);
  return _CACHED_JOB_TYPE_ID;
}

async function fetchInternalCandidateId(token, searchTerm) {
  if (!searchTerm) return null;

  const search = String(searchTerm).toLowerCase().trim();
  const candidates = await loadLocalCandidates();

  // Match by name, full_name or email
  const match = candidates.find(c =>
    (c.name || '').toLowerCase().trim() === search ||
    (c.full_name || '').toLowerCase().trim() === search ||
    (c.email || '').toLowerCase().trim() === search
  );

  if (match) {
    console.log(`[LOCAL INFO] Match for '${searchTerm}': ID ${match.id}`);
    return match.id;
  }

  console.warn(`[LOCAL INFO] No match for '${searchTerm}' in candidates.json`);
  return null;
}

async function updateCounts(row) {
  const countsPath = path.join(OUTPUT_DIR, 'counts.json');
  let counts = {};
  try {
    const data = await fs.readFile(countsPath, 'utf-8');
    counts = JSON.parse(data);
  } catch (e) { counts = {}; }

  // 1. Precise Cleanup: remove any keys that aren't modern (lowercase simple names)
  // or that are old metadata keys at the root
  for (const k in counts) {
    if (k === 'last_updated' || (k.includes('(') && k.includes(')'))) {
      delete counts[k];
    }
  }

  const candKey = row.candidate_name.toLowerCase();
  if (!counts[candKey]) {
    counts[candKey] = {
      easy_applied: 0,
      external: 0,
      failed: 0,
      skipped: 0,
      candidate_id: row.candidate_id,
      candidate_name: row.candidate_name,
      employee_id: row.employee_id,
      employee_name: row.employee_name
    };
  }

  counts[candKey].easy_applied += row.activity_count;
  counts[candKey].last_updated = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Initialize sync state if missing
  if (typeof counts[candKey].last_synced_total === 'undefined') {
    counts[candKey].last_synced_total = 0;
  }
  if (!counts[candKey].last_synced_date) {
    counts[candKey].last_synced_date = '';
  }

  await fs.writeFile(countsPath, JSON.stringify(counts, null, 2));
}

async function appendToCsv(row) {
  const candFile = row.candidate_name.replace(/\s+/g, '_').toLowerCase();
  const csvPath = path.join(OUTPUT_DIR, `${candFile}.csv`);
  const exists = await fs.access(csvPath).then(() => true).catch(() => false);

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const attempted = 'Easy Apply';
  const result = 'Success';

  // Columns: Timestamp, JobID, Job Title, Company, Candidate, Employee, Attempted, Result
  const csvLine = `"${timestamp}","${row.job_id}","${row.job_name}","${row.notes.replace('Applied to ', '').split(' via ')[0]}","${row.candidate_name}","${row.employee_name}","${attempted}","${result}"\n`;

  if (!exists) {
    const header = "Timestamp,JobID,Job Title,Company,Candidate,Employee,Attempted,Result\n";
    await fs.writeFile(csvPath, header + csvLine);
  } else {
    await fs.appendFile(csvPath, csvLine);
  }
}

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || '').trim();
const ALLOWED = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

// Optional DB Config
const hasDbConfig = process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME;
console.log('--- Server Configuration ---');
console.log('Database Configured:', hasDbConfig ? 'YES' : 'NO');
console.log('Remote API URL:', process.env.REMOTE_API_URL || '(not set)');
console.log('----------------------------');

if (!hasDbConfig) {
  console.log('ℹ️ Local Database not configured. Data will be saved to CSV/Counts files and synced to Production API only.');
}

const pool = hasDbConfig ? mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONN_LIMIT || '10', 10),
  queueLimit: 0
}) : null;

async function syncStartupCounts() {
  console.log('[STARTUP] Syncing persisted counts to website...');
  try {
    const countsPath = path.join(OUTPUT_DIR, 'counts.json');
    let data;
    try {
      data = await fs.readFile(countsPath, 'utf-8');
    } catch (e) {
      return console.log('[STARTUP] No counts.json found, skipping sync.');
    }
    const counts = JSON.parse(data);
    const token = (process.env.JWT_TOKEN || '').trim();
    if (!token) return console.log('[STARTUP] No token, skipping sync.');

    const jobId = await fetchInternalJobTypeId(token);
    const empId = await fetchInternalEmployeeId(token);
    const today = new Date().toISOString().slice(0, 10);

    let updated = false;

    for (const key in counts) {
      if (key === 'last_updated') continue;
      const c = counts[key];
      if (typeof c.easy_applied === 'undefined') continue;

      const currentTotal = Number((c.easy_applied || 0) + (c.external || 0));
      const lastSyncedTotal = Number(c.last_synced_total || 0);
      const lastSyncedDate = c.last_synced_date || '';
      const lastErrorDate = c.last_error_date || '';

      // Only attempt sync if we haven't SUCCEEDED today AND we haven't FAILED today
      if (lastSyncedDate !== today && lastErrorDate !== today) {
        // Directly use candidate_id from counts.json - no lookup needed!
        const candId = c.candidate_id;
        console.log(`[DEBUG] Using candidate ID ${candId} for ${c.candidate_name}`);


        const payload = {
          job_id: Number(jobId),
          // candidate_id removed - API uses candidate_name instead (matches Python code)
          candidate_name: c.candidate_name || key,
          employee_id: Number(c.employee_id || empId),
          employee_name: c.employee_name || "Employee",
          activity_date: today,
          activity_count: currentTotal,
          notes: `[STARTUP SYNC] Total: ${currentTotal}`
        };

        console.log(`[STARTUP] Syncing ${payload.candidate_name} (ID: ${payload.candidate_id}, Job: ${payload.job_id}, Emp: ${payload.employee_id}) total: ${payload.activity_count}...`);
        console.log(`[DEBUG] Full payload JSON:`, JSON.stringify(payload, null, 2));


        const remoteUrl = (process.env.REMOTE_API_URL || '').replace(/\/+$/, '');
        const resp = await fetch(remoteUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify(payload)
        });

        if (resp.ok) {
          console.log(`[STARTUP] Sync Success for ${payload.candidate_name}`);
          c.last_synced_total = currentTotal;
          c.last_synced_date = today;
          c.last_error_date = '';
          updated = true;
        } else {
          const errText = await resp.text();
          console.error(`[STARTUP] Sync Failed for ${payload.candidate_name}: Status ${resp.status} | Response: ${errText}`);
          c.last_error_date = today;
          c.last_error_message = errText;
          updated = true; // Still update counts.json to save the error date
        }
      } else {
        const reason = lastErrorDate === today
          ? `Last attempt failed: ${c.last_error_message || '404 select a job/candidate'}`
          : "Already synced today";
        console.log(`[STARTUP] Skipping ${c.candidate_name} (${reason})`);
      }
    }

    if (updated) {
      await fs.writeFile(countsPath, JSON.stringify(counts, null, 2));
    }
  } catch (e) {
    console.error('[STARTUP] Sync failed', e.message);
  }
}

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '50mb' }));

// CORS
if (ALLOWED.length > 0) {
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED.includes(origin)) return callback(null, true);
      return callback(new Error('CORS not allowed'), false);
    }
  }));
} else {
  app.use(cors());
}

// --- DEBUG LOGGING MIDDLEWARE ---
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`\n[INCOMING] ${req.method} ${req.path} | Time: ${new Date().toLocaleTimeString()}`);
  }
  next();
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API key middleware
app.use((req, res, next) => {
  if (!API_KEY) return next();
  const auth = req.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    console.warn('[SERVER] Auth Failed: Missing/Invalid Header');
    return res.status(401).json({ error: 'missing auth header' });
  }
  const token = auth.slice(7).trim();
  if (token !== API_KEY) {
    console.warn('[SERVER] Auth Failed: Key Mismatch');
    return res.status(403).json({ error: 'invalid token' });
  }
  return next();
});


app.post('/api/job-activity', async (req, res) => {
  console.log(`\n[SERVER] Received Request (${req.body?.rows?.length || 0} rows) at ${new Date().toLocaleTimeString()}`);
  try {
    const body = req.body;
    if (!body || !Array.isArray(body.rows)) return res.status(400).json({ error: 'invalid payload' });

    const defaultJobId = (typeof body.default_job_id !== 'undefined' && body.default_job_id !== null)
      ? Number(body.default_job_id)
      : 14;

    const rows = [];
    for (const r of body.rows) {
      const candidate_id = Number(r.candidate_id || 0);
      const employee_id = Number(r.employee_id || 0);
      const activity_date = String(r.activity_date || '').trim();
      const activity_count = Number(r.activity_count || 0);
      const job_name = r.job_name || '';
      const notes = r.notes || '';
      const candidate_name = r.candidate_name || 'unknown';
      const employee_name = r.employee_name || '';

      const job_id = (typeof r.job_id !== 'undefined' && r.job_id !== null)
        ? Number(r.job_id)
        : defaultJobId;

      if (!candidate_id || !employee_id || !activity_date) continue;

      const processedRow = { job_id, candidate_id, employee_id, activity_date, activity_count, job_name, notes, candidate_name, employee_name };
      rows.push(processedRow);

      // --- Local File Logging ---
      await updateCounts(processedRow);
      await appendToCsv(processedRow);
    }

    if (rows.length === 0) return res.status(400).json({ error: 'no valid rows' });

    // Log each job in the terminal so the user sees immediate progress
    rows.forEach(r => {
      console.log(`\n>>> [LOGGED] Candidate: ${r.candidate_name} | Employee: ${r.employee_name} | Job: ${r.job_name} | ID: ${r.job_id} <<<\n`);
    });

    let inserted = 0;

    // --- Local DB Sync ---
    if (pool) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const insertSql = `INSERT INTO job_activity_log
          (job_id, candidate_id, employee_id, activity_date, activity_count, json_downloaded, sql_downloaded)
          VALUES (?, ?, ?, ?, ?, 'yes', 'no')
          ON DUPLICATE KEY UPDATE
            activity_count = activity_count + VALUES(activity_count),
            last_mod_date = CURRENT_TIMESTAMP,
            json_downloaded = 'yes'`;
        for (const r of rows) {
          await conn.execute(insertSql, [r.job_id, r.candidate_id, r.employee_id, r.activity_date, r.activity_count]);
          inserted++;
        }
        await conn.commit();
      } catch (dbErr) {
        await conn.rollback();
        console.error('DB error', dbErr);
      } finally {
        conn.release();
      }
    }

    // --- Remote Website Sync ---
    let remoteStatus = 'skipped';
    if (process.env.REMOTE_API_URL && rows.length > 0) {
      const token = (process.env.JWT_TOKEN || '').trim();
      const internalJobId = await fetchInternalJobTypeId(token);
      const internalEmpId = await fetchInternalEmployeeId(token);

      let successCount = 0;
      let failCount = 0;

      for (const r of rows) {
        try {
          const remoteUrl = process.env.REMOTE_API_URL.replace(/\/+$/, '');

          const payload = {
            job_id: Number(internalJobId),
            candidate_name: r.candidate_name,
            employee_id: Number(internalEmpId),
            employee_name: r.employee_name || "Employee",
            activity_date: r.activity_date,
            activity_count: Number(r.activity_count),
            notes: r.notes || `${r.job_name} | ${r.notes}`
          };

          // Simple POST - counts accumulate in counts.json and sync at startup
          const remoteResp = await fetch(remoteUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(payload)
          });

          if (remoteResp.ok) {
            successCount++;
            console.log(`[SYNC INFO] Posted to website: ${r.candidate_name} | ${r.job_name}`);
          } else {
            const errTxt = await remoteResp.text();
            console.error(`[REMOTE ERROR] ${r.candidate_name} failed: ${errTxt}`);
            failCount++;
          }
        } catch (err) {
          console.error('[REMOTE SYNC ERROR]:', err.message);
          failCount++;
        }
      }
      remoteStatus = `Syncing Done. Success: ${successCount}, Fail: ${failCount}`;
    }

    return res.json({ ok: true, inserted: rows.length, runId: body.runId || null, remoteStatus });
  } catch (err) {
    console.error('server error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.post('/api/save-jobs', async (req, res) => {
  try {
    const jobs = req.body.jobs;
    if (!Array.isArray(jobs)) return res.status(400).json({ error: 'invalid jobs array' });
    const filePath = path.join(__dirname, '../easyapply_today.json');
    await fs.writeFile(filePath, JSON.stringify(jobs, null, 2), 'utf-8');
    console.log(`Saved ${jobs.length} jobs to disk.`);
    res.json({ ok: true, count: jobs.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  syncStartupCounts();
});
