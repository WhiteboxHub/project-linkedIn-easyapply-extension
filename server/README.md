EasyApply Server - quick start (dev)

1. Copy .env.example -> .env and fill DB_* values:
   DB_HOST, DB_USER, DB_PASS, DB_NAME

2. Ensure your MySQL database has the table job_activity_log (your DDL).
   Add unique index to allow upsert:
     ALTER TABLE job_activity_log
       ADD UNIQUE KEY uniq_cand_emp_date (candidate_id, employee_id, activity_date);

3. Install dependencies:
   cd server
   npm install

4. Start server:
   npm start

Server listens on PORT (default 3000). Dev mode: API_KEY empty => no auth required.

Test with curl:
curl -X POST "http://localhost:3000/api/job-activity" \
  -H "Content-Type: application/json" \
  -d '{
    "runId":"test1",
    "default_job_id":14,
    "rows":[{"candidate_id":522,"employee_id":10,"activity_date":"2025-11-24","activity_count":2}]
  }'
