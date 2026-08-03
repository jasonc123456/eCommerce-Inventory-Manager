import { describe, expect, it } from 'vitest';

import { createMetrics, observeDuration } from './metrics';

describe('createMetrics', () => {
  it('registers every metric on its own registry', async () => {
    const metrics = createMetrics({ collectDefaults: false });
    metrics.jobsCompleted.inc({ jobType: 'project_inventory', outcome: 'success' });

    const rendered = await metrics.registry.metrics();

    expect(rendered).toContain('eim_jobs_completed_total');
    expect(rendered).toContain('jobType="project_inventory"');
  });

  it('isolates registries, so one process cannot publish another process metrics', async () => {
    const first = createMetrics({ collectDefaults: false });
    const second = createMetrics({ collectDefaults: false });

    first.deadLetteredJobs.inc({ jobType: 'push_listing' });

    expect(await second.registry.metrics()).not.toContain('jobType="push_listing"');
  });

  it('honours a prefix', async () => {
    const metrics = createMetrics({ collectDefaults: false, prefix: 'test_' });
    metrics.queueDepth.set({ queue: 'default' }, 3);

    expect(await metrics.registry.metrics()).toContain('test_queue_depth');
  });

  it('collects process metrics by default', async () => {
    const metrics = createMetrics();

    expect(await metrics.registry.metrics()).toContain('eim_process_cpu_user_seconds_total');
  });

  it('uses only bounded label names', () => {
    // Section 22 bans high-cardinality labels. This asserts the intent rather
    // than trusting review: a `businessId` label would create one time series
    // per business and is the documented way this endpoint becomes an outage.
    const banned = ['businessId', 'userId', 'orderId', 'listingId', 'email', 'sku'];
    const metrics = createMetrics({ collectDefaults: false });

    const declared = metrics.registry
      .getMetricsAsArray()
      .flatMap((metric) => (metric as { labelNames?: string[] }).labelNames ?? []);

    for (const label of declared) {
      expect(banned).not.toContain(label);
    }
  });
});

describe('observeDuration', () => {
  it('records a successful operation', async () => {
    const metrics = createMetrics({ collectDefaults: false });

    const value = await observeDuration(metrics.providerLatency, { provider: 'ebay' }, async () =>
      Promise.resolve(7),
    );

    expect(value).toBe(7);
    expect(await metrics.registry.metrics()).toContain(
      'eim_provider_call_duration_seconds_count{provider="ebay"} 1',
    );
  });

  it('records a failing operation and rethrows', async () => {
    // The slow call just before a timeout is the one worth measuring, so a
    // histogram that only sees successes hides the latency that matters.
    const metrics = createMetrics({ collectDefaults: false });

    await expect(
      observeDuration(metrics.providerLatency, { provider: 'woocommerce' }, () =>
        Promise.reject(new Error('gateway timeout')),
      ),
    ).rejects.toThrow('gateway timeout');

    expect(await metrics.registry.metrics()).toContain(
      'eim_provider_call_duration_seconds_count{provider="woocommerce"} 1',
    );
  });
});
