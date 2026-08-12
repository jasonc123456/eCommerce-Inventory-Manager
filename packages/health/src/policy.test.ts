import { describe, expect, it } from 'vitest';

import {
  backupVerdict,
  clockVerdict,
  describeAge,
  diskVerdict,
  heartbeatVerdict,
  queueVerdict,
  worst,
  DISK_PAUSE_FREE_FRACTION,
  DISK_RESUME_FREE_FRACTION,
} from './policy';

/**
 * What counts as unwell (sections 22, 23).
 *
 * These are the judgements that decide when somebody's evening is interrupted,
 * so each one is asserted on both sides of its threshold. The hysteresis test
 * is the one that matters most: without a gap between pausing and resuming,
 * a full disk produces an alert every time the sweep runs.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe('worst', () => {
  it('is the worst of what it is given', () => {
    expect(worst([])).toBe('ok');
    expect(worst(['ok', 'ok'])).toBe('ok');
    expect(worst(['ok', 'degraded'])).toBe('degraded');
    expect(worst(['failing', 'ok'])).toBe('failing');
    expect(worst(['degraded', 'failing', 'ok'])).toBe('failing');
  });
});

describe('diskVerdict', () => {
  const gigabyte = 1024 ** 3;

  function reading(freeFraction: number, dailyGrowthBytes?: number) {
    return {
      totalBytes: 100 * gigabyte,
      freeBytes: Math.round(100 * gigabyte * freeFraction),
      ...(dailyGrowthBytes === undefined ? {} : { dailyGrowthBytes }),
    };
  }

  it('is content with room to spare', () => {
    expect(diskVerdict(reading(0.5)).status).toBe('ok');
  });

  it('warns below a fifth free and fails below a tenth', () => {
    expect(diskVerdict(reading(0.19)).status).toBe('degraded');
    expect(diskVerdict(reading(0.09)).status).toBe('failing');
  });

  it('warns on a projection even when there is still room', () => {
    // Section 22 warns "when projected exhaustion is within seven days", which
    // is the case a percentage on its own cannot see coming.
    const filling = diskVerdict(reading(0.4, 10 * gigabyte));

    expect(filling.status).toBe('degraded');
    expect(filling.daysRemaining).toBe(4);
    expect(filling.detail).toContain('4 days');
  });

  it('does not project from a single reading', () => {
    // A projection from one sample is a guess presented as arithmetic.
    expect(diskVerdict(reading(0.4)).daysRemaining).toBeNull();
    expect(diskVerdict(reading(0.4, 0)).daysRemaining).toBeNull();
  });

  it('pauses growth-heavy work below five percent', () => {
    expect(diskVerdict(reading(0.04)).pauseGrowth).toBe(true);
    expect(diskVerdict(reading(0.5)).pauseGrowth).toBe(false);
  });

  it('does not flap between pausing and resuming', () => {
    // Between the two thresholds the previous decision stands. Without this a
    // rotated log resumes an import that fills the disk that pauses the import.
    const between = (DISK_PAUSE_FREE_FRACTION + DISK_RESUME_FREE_FRACTION) / 2;

    expect(diskVerdict(reading(between), true).pauseGrowth).toBe(true);
    expect(diskVerdict(reading(between), false).pauseGrowth).toBe(false);

    // And the hysteresis has an end: enough free space resumes regardless.
    expect(diskVerdict(reading(0.2), true).pauseGrowth).toBe(false);
  });

  it('says it does not know rather than reporting a healthy zero', () => {
    expect(diskVerdict({ freeBytes: 0, totalBytes: 0 }).status).toBe('degraded');
  });
});

describe('heartbeatVerdict', () => {
  it('is content with a recent beat', () => {
    expect(heartbeatVerdict(minutesAgo(0.5), NOW).status).toBe('ok');
  });

  it('degrades on a missed beat and fails on a missing process', () => {
    // A worker that missed one beat was busy; one silent for five minutes is
    // gone, and only the second is worth waking somebody for.
    expect(heartbeatVerdict(minutesAgo(2), NOW).status).toBe('degraded');
    expect(heartbeatVerdict(minutesAgo(10), NOW).status).toBe('failing');
  });

  it('treats never having reported as a failure', () => {
    expect(heartbeatVerdict(null, NOW)).toEqual({
      status: 'failing',
      detail: 'has never reported',
    });
  });
});

describe('queueVerdict', () => {
  it('is content when nothing is waiting', () => {
    expect(queueVerdict(null, 0).status).toBe('ok');
    expect(queueVerdict(600, 0).status).toBe('ok');
  });

  it('judges by age rather than by depth', () => {
    // Ten thousand jobs enqueued a second ago is a busy afternoon. One job
    // enqueued an hour ago is a worker that is not running.
    expect(queueVerdict(1, 10_000).status).toBe('ok');
    expect(queueVerdict(3600, 1).status).toBe('failing');
  });

  it('degrades before it fails', () => {
    expect(queueVerdict(400, 5).status).toBe('degraded');
  });
});

describe('clockVerdict', () => {
  it('tolerates a little and refuses a lot, in both directions', () => {
    expect(clockVerdict(200).status).toBe('ok');
    expect(clockVerdict(-200).status).toBe('ok');
    expect(clockVerdict(5_000).status).toBe('degraded');
    expect(clockVerdict(-60_000).status).toBe('failing');
  });
});

describe('backupVerdict', () => {
  it('is content with last night', () => {
    expect(backupVerdict(new Date(NOW.getTime() - 6 * 3_600_000), NOW).status).toBe('ok');
  });

  it('notices a missed night, then a broken schedule', () => {
    expect(backupVerdict(new Date(NOW.getTime() - 40 * 3_600_000), NOW).status).toBe('degraded');
    expect(backupVerdict(new Date(NOW.getTime() - 96 * 3_600_000), NOW).status).toBe('failing');
  });

  it('does not treat a new installation as broken', () => {
    // It has never taken a backup and is not broken; it is new. What it needs
    // is the sentence, not the alarm.
    expect(backupVerdict(null, NOW).status).toBe('degraded');
  });
});

describe('describeAge', () => {
  it('rounds to the unit somebody would actually say', () => {
    expect(describeAge(5_000)).toBe('5s');
    expect(describeAge(10 * 60_000)).toBe('10m');
    expect(describeAge(5 * 3_600_000)).toBe('5h');
    expect(describeAge(5 * 24 * 3_600_000)).toBe('5d');
  });

  it('never reports a negative age from a clock that stepped backwards', () => {
    expect(describeAge(-5_000)).toBe('0s');
  });
});
