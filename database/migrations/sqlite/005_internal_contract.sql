BEGIN IMMEDIATE;
ALTER TABLE document ADD COLUMN requested_retention_days INTEGER CHECK(requested_retention_days BETWEEN 1 AND 90);
PRAGMA user_version=5;
COMMIT;
