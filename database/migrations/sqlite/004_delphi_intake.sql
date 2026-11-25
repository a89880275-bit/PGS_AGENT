BEGIN IMMEDIATE;
ALTER TABLE document ADD COLUMN integration_fingerprint TEXT;
CREATE TABLE pgs_intake_event (id INTEGER PRIMARY KEY, at TEXT NOT NULL, event TEXT NOT NULL, code TEXT NOT NULL);
PRAGMA user_version=4;
COMMIT;
