BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS document_link (
 document_id TEXT NOT NULL REFERENCES document(document_id),
 generation INTEGER NOT NULL CHECK(generation>0),
 sealed_token TEXT NOT NULL,
 PRIMARY KEY(document_id,generation)
);
ALTER TABLE document ADD COLUMN birth_salt TEXT;
ALTER TABLE document ADD COLUMN birth_key_version INTEGER NOT NULL DEFAULT 1;
PRAGMA user_version=2;
COMMIT;