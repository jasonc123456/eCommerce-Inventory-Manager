# The production image (section 23).
#
# One image for the web tier, the worker, migrations, and administrative
# commands, with distinct entry commands. Section 23 is explicit about that:
# "use the same versioned application image for web, worker, migrations, and
# administrative commands". Independently versioned images would let a rolling
# deployment run a worker from last week against this week's schema, which is
# the failure mode that produces symptoms nobody can reproduce.
#
# Four properties this file exists to guarantee.
#
# The runtime stage carries no source, no package manager, and no build
# toolchain. What it has is the standalone Next.js server, the bundled worker,
# the migration SQL, and the two binaries an operator needs for the parts of
# section 23 that happen outside the application: `pg_dump`/`psql`, and `age`.
#
# It runs as a non-root user with a fixed uid and gid. Section 23 pins
# PostgreSQL's `user:` to the deployment administrator's ids so that everything
# under the data root is readable without `sudo`; the application containers use
# the same ids for the same reason. They are build arguments rather than
# hardcoded because an installation whose administrator is not 1000 would
# otherwise find every exported file owned by somebody who does not exist.
#
# It has no Docker socket, no privileged capability, and no way to update
# itself. Section 23 forbids "an unattended updater" and giving "the application
# Docker-socket control", and the absence here is what makes those true rather
# than a policy somebody remembers.
#
# The build is reproducible from the lockfile alone: `--frozen-lockfile`, and a
# pinned pnpm version. A build that resolved fresh versions would produce an
# image whose digest does not describe its contents.

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

ARG PNPM_VERSION=11.18.0
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /build

# Manifests first, so a change to source does not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/audit/package.json packages/audit/
COPY packages/authz/package.json packages/authz/
COPY packages/config/package.json packages/config/
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/health/package.json packages/health/
COPY packages/identity/package.json packages/identity/
COPY packages/integrations/package.json packages/integrations/
COPY packages/inventory/package.json packages/inventory/
COPY packages/jobs/package.json packages/jobs/
COPY packages/listings/package.json packages/listings/
COPY packages/mail/package.json packages/mail/
COPY packages/notifications/package.json packages/notifications/
COPY packages/observability/package.json packages/observability/
COPY packages/providers/package.json packages/providers/
COPY packages/ratelimit/package.json packages/ratelimit/
COPY packages/retention/package.json packages/retention/
COPY packages/review/package.json packages/review/
COPY packages/shipping/package.json packages/shipping/
COPY packages/sync/package.json packages/sync/
COPY packages/testing/package.json packages/testing/
COPY packages/ui/package.json packages/ui/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM deps AS build

ARG APP_VERSION=0.0.0-dev
ENV NEXT_TELEMETRY_DISABLED=1
ENV EIM_APP_VERSION=${APP_VERSION}
# Production build. Next.js reads this at build time to decide what to inline
# and how to optimize; building with anything else produces a development bundle
# that happens to be running in production.
ENV NODE_ENV=production

COPY . .

RUN pnpm --filter @eim/db build \
 && pnpm --filter @eim/web build \
 && pnpm --filter @eim/worker build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

ARG APP_UID=1000
ARG APP_GID=1000
ARG APP_VERSION=0.0.0-dev

# `age` for backup encryption (D-143: the private key lives off this host, so
# the image needs only the public half and the ability to encrypt).
# `postgresql-client` for the logical dumps and restores section 23 makes the
# supported portable path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        age \
        ca-certificates \
        postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# The base image ships node:1000. Reuse it when the ids match, and create a
# separate account when they do not, so the container writes files the
# deployment administrator owns.
RUN if [ "${APP_UID}" != "1000" ] || [ "${APP_GID}" != "1000" ]; then \
      if ! getent group "${APP_GID}" >/dev/null; then groupadd -g "${APP_GID}" eim; fi; \
      useradd -m -u "${APP_UID}" -g "${APP_GID}" -s /usr/sbin/nologin eim; \
    fi

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV EIM_APP_VERSION=${APP_VERSION}
ENV PORT=3000

WORKDIR /app

# The standalone server, its static assets, and the public directory. Next.js
# splits these three deliberately: the server tree omits everything the build
# proved was unreachable, which is most of node_modules.
COPY --from=build --chown=${APP_UID}:${APP_GID} /build/apps/web/.next/standalone ./
COPY --from=build --chown=${APP_UID}:${APP_GID} /build/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=${APP_UID}:${APP_GID} /build/apps/web/public ./apps/web/public

# The worker, bundled to a single file by esbuild.
COPY --from=build --chown=${APP_UID}:${APP_GID} /build/apps/worker/dist ./worker

# Migrations, as SQL. The migrate command reads these at run time, so they are
# data in this image rather than something compiled into it — which is what
# lets an operator read exactly what a release will do to their database before
# running it.
COPY --from=build --chown=${APP_UID}:${APP_GID} /build/packages/db/migrations ./migrations
COPY --from=build --chown=${APP_UID}:${APP_GID} /build/packages/db/dist ./migrate

USER ${APP_UID}:${APP_GID}

EXPOSE 3000

# Liveness only. Readiness needs the database and belongs to the orchestrator or
# the proxy, not to a check that restarts the container: a readiness probe wired
# to a restart turns a brief database blip into a rolling outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
