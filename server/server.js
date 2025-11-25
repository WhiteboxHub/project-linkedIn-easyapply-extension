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

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || '').trim();
const ALLOWED = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
  console.error('Missing DB configuration in .env. Copy .env.example to .env and fill values.');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_CONN_LIMIT || '10', 10),
  queueLimit: 0
});

const app = express();
app.use(helmet());
app.use(bodyParser.json({ limit: '2mb' }));

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

// API key middleware (optional)
app.use((req, res, next) => {
  const auth = req.get('authorization') || '';
  if (!API_KEY) return next(); // dev: no key required
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing auth header' });
  const token = auth.slice(7).trim();
  if (token !== API_KEY) return res.status(403).json({ error: 'invalid token' });
  return next();
});


app.post('/api/job-activity', async (req, res) => {
  try {
    const body = req.body;
    if (!body || !Array.isArray(body.rows)) return res.status(400).json({ error: 'invalid payload' });

    // Server-side fallback: default_job_id must be 14 unless explicitly provided otherwise
    const defaultJobId = (typeof body.default_job_id !== 'undefined' && body.default_job_id !== null)
      ? Number(body.default_job_id)
      : 14;

    const rows = [];
    for (const r of body.rows) {
      const candidate_id = Number(r.candidate_id || 0);
      const employee_id = Number(r.employee_id || 0);
      const activity_date = String(r.activity_date || '').trim();
      const activity_count = Number(r.activity_count || 0);

      // If the client explicitly passed job_id use it, otherwise use defaultJobId (14)
      const job_id = (typeof r.job_id !== 'undefined' && r.job_id !== null)
        ? Number(r.job_id)
        : defaultJobId;

      if (!candidate_id || !employee_id || !activity_date) continue;
      rows.push({ job_id: job_id, candidate_id, employee_id, activity_date, activity_count });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'no valid rows' });

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
      let inserted = 0;
      for (const r of rows) {
        await conn.execute(insertSql, [r.job_id, r.candidate_id, r.employee_id, r.activity_date, r.activity_count]);
        inserted++;
      }
      await conn.commit();
      return res.json({ ok: true, inserted, runId: body.runId || null });
    } catch (dbErr) {
      await conn.rollback();
      console.error('DB error', dbErr);
      return res.status(500).json({ error: 'db error', details: String(dbErr) });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('server error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
