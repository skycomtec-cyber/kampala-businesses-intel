-- 011: opportunity_actor_count
--
-- Gives an opportunity the actor count it was derived from, so the k-anonymity
-- floor can actually be applied to it.
--
-- The bug, and it is a serious one because it is silent.
--
-- `GET /api/v1/insights/opportunities` runs every row it returns through
-- `suppressIfBelowK`, which reads `row.distinctActors`. The `opportunity` table had
-- no such column, so the read produced `undefined`, the `?? 0` fallback turned that
-- into zero, and `0 < 5` was true for every row. Every opportunity was therefore
-- classified as below the privacy floor and filtered out, and the endpoint returned
-- an empty list for every input, always.
--
-- The engine was not at fault: it wrote 20 correct candidate rows, and the
-- repository read them back correctly. Only the route's own privacy filter
-- discarded them. That is why this went unnoticed - every layer beneath the
-- endpoint worked, every log line looked healthy, and the count reported by
-- `scripts/maintenance.js` said twenty opportunities had been written.
--
-- Note what this is NOT. It is not a case of the floor being too strict and needing
-- relaxing, and nothing here weakens it. The floor is doing exactly what it was
-- written to do; it was simply being handed a number that had never been recorded.
-- The gap snapshot the opportunity was derived from always carried the true count
-- (`gap_snapshot.distinct_actors`, 30 in the demonstration that surfaced this) -
-- it was one join away and the join was missing.
--
-- The count is copied onto the row rather than joined at read time, deliberately.
-- The route's own comment records the design rule for this table: inputs are
-- stored rather than recomputed, so an opportunity stays explainable after the data
-- underneath it has moved on. An opportunity whose privacy verdict silently changed
-- when the next engine run replaced its snapshot would be exactly the instability
-- that rule exists to prevent - a row could appear or vanish from the public list
-- with no state change and no action by anyone.
--
-- The backfill reads the count from the parent snapshot. A row whose snapshot has
-- been deleted keeps a zero and therefore stays withheld, which is the correct
-- direction to fail: an opportunity that can no longer prove how many people are
-- behind it is not one to publish.

ALTER TABLE opportunity ADD COLUMN distinct_actors INTEGER NOT NULL DEFAULT 0;

UPDATE opportunity
   SET distinct_actors = COALESCE((
       SELECT g.distinct_actors
         FROM gap_snapshot g
        WHERE g.id = opportunity.gap_snapshot_id
   ), 0)
 WHERE gap_snapshot_id IS NOT NULL;
