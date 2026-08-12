# Health and alerts

Two surfaces that answer different questions. `/health` is what an installation
administrator opens when they suspect something. Alerts are what arrive when
nobody has opened anything.

## The health screen

`/health`, and it requires the `view_system_health` installation permission —
which business ownership does not confer. A stalled queue belongs to the
machine, and on a multi-tenant installation showing it to one business's owner
would tell them about the host every other business runs on.

Every check appears, including the ones that are fine. A screen that showed only
problems would be empty on a healthy day, and an empty screen is
indistinguishable from a broken one.

| Check       | Degraded when                         | Failing when                        |
| ----------- | ------------------------------------- | ----------------------------------- |
| `database`  | —                                     | Not reachable                       |
| `schema`    | —                                     | The build and the database disagree |
| `clock`     | 2s from the database clock            | 30s                                 |
| `scheduler` | No heartbeat for 90s                  | 5 minutes, or never                 |
| `workers`   | As above, freshest worker             | As above                            |
| `queue`     | Oldest job waiting 5 minutes          | 30 minutes                          |
| `storage`   | Below 20% free, or full within 7 days | Below 10%                           |
| `backups`   | 36 hours since a success, or none yet | 72 hours                            |
| `smtp`      | —                                     | The relay refused a connection      |
| `versions`  | Web and worker on different builds    | —                                   |

Each unhealthy check carries a remediation sentence beside it. The queue is
judged by _age_ rather than depth: ten thousand jobs enqueued a second ago is a
busy afternoon, one job enqueued an hour ago is a worker that is not running.

## Alerts

The worker reads the same checks every tick and files an installation alert for
each unhealthy one — and withdraws it when a later reading finds the problem
gone. An alert is only ever resolved by a fresh check proving recovery; there is
no button anywhere that closes one.

Business alerts — oversells, blocked mappings, unhealthy connections, abandoned
jobs, reconciliation conflicts — appear on `/alerts` for the people whose
permissions cover them, and are emailed according to each person's own
preference.

### What a person can do

**Acknowledge** — "I have seen this." Stops the reminders, keeps the alert
visible and counting. If the same problem gets _worse_, it speaks up again
immediately.

**Snooze** — "not now", for one to twenty-four hours. Expires by itself, so
nobody has to remember to undo it.

There is no resolve button. A button that closed an oversell alert would let
somebody make the shop look healthy while it was still selling stock it did not
have.

### Reminders

Unresolved Error and Critical alerts remind after fifteen minutes, an hour, four
hours, then daily until acknowledged or resolved. Warning and Info are said once
— an application that reminded about everything would train people to ignore the
channel Critical also arrives on.

### Quiet hours

Set on `/alerts` by somebody with `manage_notifications`, in the business's own
timezone. Email waits until the window ends. **Oversells and unsafe drift do not
wait** — those are the two that keep costing money for every hour nobody knows.
The in-app entry is never delayed.

### Destinations

A business can also send alerts to Slack, Discord, or a signed generic webhook.
The URL is treated as a credential and stored encrypted, because a Slack
incoming-webhook URL is a bearer token with a hostname in front of it. A
destination must answer a test before it can be switched on, and one that starts
failing is switched off rather than left to queue.

Generic webhooks are signed: `X-EIM-Signature: sha256=…` over
`{timestamp}.{body}`, with the timestamp in `X-EIM-Timestamp` and an idempotency
identifier in `X-EIM-Delivery`. The payload carries no buyer, order, price, or
quantity — section 13's erasure obligations cannot reach a third-party chat
service.

## Metrics

`/api/metrics`, Prometheus format, behind `EIM_METRICS_TOKEN` as a bearer token.
Unset means the endpoint answers **404**, not 401: an endpoint that is open until
somebody closes it is an endpoint that stays open.

```
scrape_configs:
  - job_name: inventory-manager
    authorization:
      credentials: <EIM_METRICS_TOKEN>
    static_configs:
      - targets: ['127.0.0.1:3000']
```

No metric is labelled by business, user, product, order, or email — that is both
a privacy rule and the difference between a metrics endpoint and an outage.
