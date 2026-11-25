BEGIN;
CREATE TABLE pgs_intake_daily (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL,
  errors INTEGER NOT NULL
);
INSERT INTO pgs_intake_daily(day, requests, errors)
SELECT date(at, '+9 hours'), count(*),
  sum(code NOT IN ('','READY','PENDING','PROCESSING','RETRY_WAIT'))
FROM pgs_intake_event WHERE event='REGISTER' GROUP BY 1;
CREATE TRIGGER pgs_rollup_intake AFTER INSERT ON pgs_intake_event
WHEN NEW.event='REGISTER'
BEGIN
  INSERT INTO pgs_intake_daily(day, requests, errors) VALUES(
    date(NEW.at, '+9 hours'), 1, NEW.code NOT IN ('','READY','PENDING','PROCESSING','RETRY_WAIT')
  ) ON CONFLICT(day) DO UPDATE SET requests=requests+1,errors=errors+excluded.errors;
END;
PRAGMA user_version=6;
COMMIT;