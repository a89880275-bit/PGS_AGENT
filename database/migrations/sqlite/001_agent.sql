BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS document(
    document_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, local_path TEXT, original_filename TEXT,
    hash TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0), state TEXT NOT NULL CHECK(state IN
      ('WRITING','LOCAL_SAVED','REGISTERING','READY','RETRY_PENDING','FAILED','DELETING','DELETED','DELETE_FAILED')),
    doc_type TEXT NOT NULL, patient_key TEXT, birth_verify TEXT, created_at TEXT NOT NULL, staged_at TEXT NOT NULL,
    registered_at TEXT, expires_at TEXT, delete_at TEXT, retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 90),
    link_validity_days INTEGER NOT NULL DEFAULT 30 CHECK(link_validity_days BETWEEN 1 AND retention_days), policy_version INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT, sync_pending INTEGER NOT NULL DEFAULT 0,
    CHECK(expires_at IS NULL OR (registered_at < expires_at AND expires_at <= delete_at))
  ); PRAGMA user_version=1;
COMMIT;