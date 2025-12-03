-- server/mysql-schema.sql
-- Add unique index for per-candidate/employee/date aggregation:
ALTER TABLE job_activity_log
  ADD UNIQUE KEY uniq_cand_emp_date (candidate_id, employee_id, activity_date);
