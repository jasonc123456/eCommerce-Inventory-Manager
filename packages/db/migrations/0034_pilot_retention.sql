-- 0034_pilot_retention
--
-- The pilot's own tables are subject to retention too (sections 13, 22, 37).
--
-- Two of the tables added by 0031 and 0032 grow with traffic rather than with
-- the catalogue: one convergence sample per change per channel, and one withheld
-- write per change during a staged pilot. At section 1's tested baseline that is
-- thousands of rows a day, and a measurement table nobody prunes is how an
-- installation runs out of disk because of the feature that was supposed to
-- warn it about running out of disk.
--
-- Both are history rather than raw classes: a mapping id, a version, a quantity,
-- and timestamps. Nothing in either reaches a buyer, so section 37's 180-day
-- history default applies and an owner may choose to keep them indefinitely.
--
-- Incidents and drills are deliberately not swept. They are the evidence for a
-- release decision — section 36 asks for the pilot criteria to pass "with
-- retained evidence" — and evidence that expires on a schedule is not evidence.
-- They are also bounded by how often something goes wrong rather than by
-- traffic, which is the property that makes keeping them affordable.

alter table retention_runs drop constraint retention_runs_class_known;

alter table retention_runs add constraint retention_runs_class_known
  check (data_class in (
    'notification_deliveries', 'resolved_alerts', 'ai_suggestions',
    'convergence_samples', 'withheld_writes',
    'webhook_deliveries', 'processed_events'
  ));
