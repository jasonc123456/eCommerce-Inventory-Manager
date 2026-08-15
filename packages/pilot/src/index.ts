/**
 * The controlled pilot (sections 1, 36).
 *
 * Three things live here, and they are separate on purpose.
 *
 * `stages` decides what may be written to a live provider yet, and records what
 * it stopped. `samples` records how long each change took to arrive. `criteria`
 * turns section 1's eight-line acceptance bar into verdicts backed by both.
 *
 * Nothing in this package writes to a provider, and nothing in it can widen a
 * stage on its own. Both are deliberate: the gate that decides whether a pilot
 * is going well must not be the thing that decides to escalate it.
 */

export type { PilotExecutor } from './executor';

export {
  ABANDON_AFTER_MS,
  abandonStaleSamples,
  excludeSample,
  markConverged,
  markSuperseded,
  openSample,
  operatorOrigin,
  type ChangeOrigin,
  type OpenSampleInput,
} from './samples';

export {
  BASELINE_INTERVAL_SECONDS,
  SLO_TAIL_ATTAINMENT,
  SLO_TAIL_MS,
  SLO_TARGET_ATTAINMENT,
  SLO_TARGET_MS,
  measureSlo,
  type ExclusionCount,
  type SloReport,
  type SloWindow,
} from './slo';

export {
  enroll,
  mayWrite,
  readStage,
  recordWithheld,
  setStage,
  stageCeiling,
  stageWrites,
  unenroll,
  type EnrollmentChange,
  type StageChange,
  type StageView,
  type WriteDecision,
} from './stages';

export {
  MIN_SETTLED_SAMPLES,
  PILOT_CRITERIA,
  PILOT_DURATION_DAYS,
  assessPilot,
  type CriterionResult,
  type CriterionVerdict,
  type PilotCriterionId,
  type PilotReport,
} from './criteria';

export {
  classifyIncident,
  fileIncident,
  listDrills,
  listIncidents,
  recordDrill,
  type ClassificationResult,
  type DrillView,
  type IncidentView,
} from './incidents';
