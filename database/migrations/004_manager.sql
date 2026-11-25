CREATE TABLE IF NOT EXISTS pgs_manager_user (
 username text PRIMARY KEY, role text NOT NULL CHECK(role IN ('SYSTEM','OPERATOR','VIEWER')),
 password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS pgs_manager_session (
 token_hash char(64) PRIMARY KEY, username text NOT NULL REFERENCES pgs_manager_user(username),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pgs_manager_session_expiry ON pgs_manager_session(expires_at);
CREATE TABLE IF NOT EXISTS pgs_manager_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, event text NOT NULL,
 subject text, occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pgs_document_type (
 code varchar(20) PRIMARY KEY, name text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
 enabled boolean NOT NULL DEFAULT true
);
INSERT INTO pgs_document_type(code,name,title) VALUES
 ('G001','외래 안내문','외래 안내문'),('G002','검사 안내문','검사 안내문') ON CONFLICT DO NOTHING;