ALTER TABLE pgs_document ADD COLUMN IF NOT EXISTS birth_salt char(64);
ALTER TABLE pgs_document ADD COLUMN IF NOT EXISTS initial_token_hash char(64);
ALTER TABLE pgs_access_token ADD COLUMN IF NOT EXISTS token_id uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE pgs_access_token ADD COLUMN IF NOT EXISTS issued_at timestamptz;
ALTER TABLE pgs_access_token ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE pgs_access_token t SET issued_at=d.registered_at FROM pgs_document d
  WHERE t.document_id=d.document_id AND t.issued_at IS NULL;
ALTER TABLE pgs_access_token ALTER COLUMN issued_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE pgs_access_token ALTER COLUMN issued_at SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pgs_token_id ON pgs_access_token(token_id);
CREATE UNIQUE INDEX IF NOT EXISTS pgs_token_document_identity ON pgs_access_token(token_id,document_id,token_hash);
ALTER TABLE pgs_access_token DROP CONSTRAINT IF EXISTS pgs_access_token_document_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS pgs_one_active_token ON pgs_access_token(document_id) WHERE revoked_at IS NULL;

ALTER TABLE pgs_session ADD COLUMN IF NOT EXISTS token_id uuid;
ALTER TABLE pgs_session ADD COLUMN IF NOT EXISTS document_id uuid;
ALTER TABLE pgs_session ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE pgs_session ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE pgs_session s SET token_id=t.token_id,document_id=t.document_id,created_at=LEAST(t.issued_at,s.expires_at)
  FROM pgs_access_token t WHERE s.token_hash=t.token_hash AND s.token_id IS NULL;
ALTER TABLE pgs_session ALTER COLUMN token_id SET NOT NULL;
ALTER TABLE pgs_session ALTER COLUMN document_id SET NOT NULL;
ALTER TABLE pgs_session ALTER COLUMN created_at SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pgs_session_token_document' AND conrelid='pgs_session'::regclass) THEN
    ALTER TABLE pgs_session ADD CONSTRAINT pgs_session_token_document FOREIGN KEY(token_id,document_id,token_hash)
      REFERENCES pgs_access_token(token_id,document_id,token_hash) ON DELETE CASCADE;
  END IF;
END $$;
ALTER TABLE pgs_security_log ADD COLUMN IF NOT EXISTS event_type text DEFAULT 'AUTH' NOT NULL;
CREATE TABLE IF NOT EXISTS pgs_auth_rate (
 bucket char(64) NOT NULL, window_start bigint NOT NULL, hits integer NOT NULL CHECK(hits>0), PRIMARY KEY(bucket,window_start)
);