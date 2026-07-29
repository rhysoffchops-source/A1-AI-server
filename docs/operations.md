# Operations

## Start and stop

Install and verify:

```bash
./scripts/bootstrap.sh
```

Start on the loopback interface:

```bash
npm start
```

A1 handles `SIGINT` and `SIGTERM`, stops accepting HTTP traffic, aborts active tasks, releases task
leases, closes components in reverse order, and flushes the audit journal. Do not send `SIGKILL`
unless the configured shutdown deadline has elapsed.

## Health and metrics

```bash
curl --fail http://127.0.0.1:8787/health/live
curl --fail http://127.0.0.1:8787/health/ready
curl --fail http://127.0.0.1:8787/metrics
```

Liveness proves the process can respond. Readiness checks every required dependency. Optional model
providers degrade readiness without taking the API out of service. Metrics use Prometheus text
format. The dashboard is available at `http://127.0.0.1:8787/`.

## Authentication

Authentication is disabled only in the loopback development configuration. To enable it, set
`security.authentication.enabled: true` and provide the named token secret:

```bash
export A1_SECRET_AUTH_TOKEN='a randomly generated value of at least 32 bytes'
```

Use a token issued by `HmacTokenService` as `Authorization: Bearer <token>`. Roles and permissions
are configured in YAML. Do not expose an authentication-disabled process beyond loopback.

## Secrets

A secret handle `provider.key` maps to `A1_SECRET_PROVIDER_KEY`. Secret values must not appear in
YAML. The encrypted-file resolver uses a 32-byte AES-256-GCM key and atomic file replacement when
embedded into another composition.

## Backups

`POST /api/v1/backups` creates consistent SQLite snapshots of scheduler, memory, and project
databases plus the audit journal. Objects and their SHA-256 hashes are committed before the
manifest. `GET /api/v1/backups` lists verified manifests.

Restoration is deliberately offline so an open SQLite connection cannot overwrite a restored
database. Stop A1, use `BackupService.restore` with explicit targets in a maintenance process,
verify `/health/ready`, and retain the previous data directory until validation completes.

## Docker

```bash
docker compose -f docker/compose.yaml up --build
```

The container runs as an unprivileged user with a read-only root filesystem and a persistent
`/opt/a1/data/runtime` volume. The API is published on loopback. Configure the NVIDIA Container
Toolkit when local GPU telemetry is required inside Docker.

## Vast.ai

Configure a `vast-ai` compute provider and provide its secret handle. Provisioning requires an
approval for `compute.provision` targeting `<provider-id>:<offer-id>`. Releasing requires an
approval for `compute.release` targeting `<provider-id>:<instance-id>`. SSH execution requires a
populated known-hosts file; host-key verification is never disabled.
