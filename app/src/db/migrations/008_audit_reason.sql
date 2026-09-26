-- Why a decision was made.
--
-- The verification route has always accepted a `reason` and always thrown it
-- away, because there was nowhere to put it. That matters more than a missing
-- convenience column: a verification decision is a claim about reality, and the
-- audit log is the only record of who claimed what. "Verified" with no stated
-- basis is indistinguishable from "verified" because somebody pressed a button,
-- and a directory that cannot say why a listing was published is a directory
-- nobody can correct.
--
-- Nullable, because most audit entries are not decisions: creates, edits and
-- deletions carry before/after and need no justification.
ALTER TABLE audit_log ADD COLUMN reason TEXT;

-- A reviewer working through a queue asks "what did we decide about this entity
-- and why", not "what happened to this entity in date order", and the existing
-- entity index is ordered by created_at only because that was all it had.
CREATE INDEX idx_audit_entity_created
  ON audit_log(entity_type, entity_id, created_at DESC);
