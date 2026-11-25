CREATE TABLE IF NOT EXISTS pgs_agent (
 agent_id uuid PRIMARY KEY, client_id uuid NOT NULL, enabled boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('ONLINE','OFFLINE')),
 last_seen_at timestamptz, UNIQUE(agent_id,client_id)
);
CREATE SEQUENCE IF NOT EXISTS pgs_policy_version START 1;
CREATE TABLE IF NOT EXISTS pgs_retention_policy (
 code varchar(20) PRIMARY KEY, retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 90),
 link_validity_days integer NOT NULL DEFAULT 30 CHECK (link_validity_days BETWEEN 1 AND retention_days),
 policy_version bigint NOT NULL DEFAULT nextval('pgs_policy_version')
);
INSERT INTO pgs_retention_policy(code) VALUES ('DEFAULT') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS pgs_policy_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, code text NOT NULL,
 old_retention integer, old_validity integer, new_retention integer NOT NULL, new_validity integer NOT NULL, changed_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS pgs_document (
 document_id uuid PRIMARY KEY, agent_id uuid NOT NULL, client_id uuid NOT NULL, request_id varchar(100) NOT NULL,
 patient_key char(64), birth_verify char(64), key_version integer NOT NULL DEFAULT 1,
 doc_type varchar(20) NOT NULL, doc_title varchar(200) NOT NULL, file_size bigint NOT NULL CHECK(file_size > 0),
 file_hash char(64), created_at timestamptz NOT NULL,
 registered_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, delete_at timestamptz NOT NULL,
 retention_days integer NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 90),
 link_validity_days integer NOT NULL DEFAULT 30 CHECK(link_validity_days BETWEEN 1 AND retention_days),
 policy_version bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('REGISTERING','READY','EXPIRED','REVOKED','DELETING','DELETED','DELETE_FAILED')),
 deleted_at timestamptz, link_generation integer NOT NULL DEFAULT 1, CHECK(registered_at < expires_at AND expires_at <= delete_at),
 UNIQUE(client_id,request_id), FOREIGN KEY(agent_id,client_id) REFERENCES pgs_agent(agent_id,client_id)
);
CREATE INDEX IF NOT EXISTS pgs_document_agent_status ON pgs_document(agent_id,status);
CREATE INDEX IF NOT EXISTS pgs_document_status_delete ON pgs_document(status,delete_at);
CREATE INDEX IF NOT EXISTS pgs_document_patient ON pgs_document(patient_key,registered_at);
CREATE TABLE IF NOT EXISTS pgs_access_token (
 token_hash char(64) PRIMARY KEY, document_id uuid NOT NULL REFERENCES pgs_document(document_id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, fail_count integer NOT NULL DEFAULT 0 CHECK(fail_count >= 0), locked_until timestamptz,
 UNIQUE(document_id)
);
CREATE TABLE IF NOT EXISTS pgs_session (
 session_hash char(64) PRIMARY KEY, token_hash char(64) NOT NULL REFERENCES pgs_access_token(token_hash) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pgs_session_expiry ON pgs_session(expires_at);
CREATE TABLE IF NOT EXISTS pgs_transfer_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, document_id uuid, result_code text NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS pgs_delete_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, document_id uuid NOT NULL, result_code text NOT NULL, occurred_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS pgs_security_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_key text NOT NULL, result_code text NOT NULL, occurred_at timestamptz NOT NULL
);