-- No deadline recalculation or data removal. Known phase 0/1 never deployed a physical schema.
ALTER TABLE pgs_document ALTER COLUMN retention_days SET DEFAULT 30;
ALTER TABLE pgs_document ALTER COLUMN link_validity_days SET DEFAULT 30;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pgs_document' AND column_name='storage_key' AND table_schema=current_schema()) THEN
    COMMENT ON COLUMN pgs_document.storage_key IS 'Deprecated legacy field; v2.3 never writes storage keys';
  END IF;
END $$;
