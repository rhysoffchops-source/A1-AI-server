# Enrolled workers

The A1 VPS is the single control endpoint. Macs and GPU machines do not expose an inbound shell to
the internet; each runs an A1 worker that makes an authenticated outbound connection to the VPS. The
worker reports its health and project state, claims queued commands, and returns an audited result.

## Topology

```text
                 private tailnet / HTTPS
M1 ───────┐                                      ┌── A1 API, Concierge, database, queue
Intel ────┼── outbound A1 workers ───────────────┤   Avena VPS
Vast GPU ─┘                                      └── Vast API controls

M1 / VPS ─── private model requests over Tailscale ─── vLLM or Ollama on Vast
```

Tailscale provides private network reachability. It does not move model weights or GPU work to the
M1: a large model still runs on the Vast GPU, with its cache stored on the attached Vast volume. The
M1 and the VPS use that GPU model through its OpenAI-compatible endpoint.

## Declare workers on the VPS

Add each trusted machine to the deployed A1 configuration. The secret handles below resolve only
from VPS environment variables; no token value belongs in YAML or source control.

```yaml
workers:
  databaseBusyTimeoutMs: 5000
  databasePath: /opt/a1/data/runtime/workers.sqlite
  definitions:
    - id: m1
      name: Dan's M1
      platform: macos
      tokenSecret: workers.m1.token
      allowedRoots:
        - /Users/dan/Documents
    - id: intel
      name: Intel workstation
      platform: linux
      tokenSecret: workers.intel.token
      allowedRoots:
        - /srv/projects
    - id: vast-gpu
      name: Vast GPU worker
      platform: linux
      tokenSecret: workers.vast-gpu.token
      allowedRoots:
        - /data
```

For these handles, the VPS service receives `A1_SECRET_WORKERS_M1_TOKEN`,
`A1_SECRET_WORKERS_INTEL_TOKEN`, and `A1_SECRET_WORKERS_VAST_GPU_TOKEN`. Generate a different,
high-entropy token for every worker and keep the matching value only in that worker's local service
environment.

## Start a worker

Copy `scripts/a1-worker.mjs` to the enrolled machine. Node.js 22+ is required. The worker needs only
outbound access to the A1 endpoint. With Tailscale, use the VPS's tailnet name or IP rather than a
public port.

```bash
export A1_WORKER_CONTROL_URL='https://a1.example.ts.net'
export A1_WORKER_ID='m1'
export A1_WORKER_TOKEN='the-matching-worker-token'
export A1_WORKER_ALLOWED_ROOTS='/Users/dan/Documents'
export A1_WORKER_PROJECT_ROOTS='/Users/dan/Documents/A1:/Users/dan/Documents/A1-Projects'
# Git workspaces are discovered recursively to this depth; the default is 3.
export A1_WORKER_DISCOVERY_DEPTH='3'
# Must be outside source projects so it remains available while a project is locked.
export A1_WORKER_LOCK_DIRECTORY="$HOME/.a1-worker-locks"
node /opt/a1/a1-worker.mjs
```

Each `A1_WORKER_PROJECT_ROOTS` entry can be either one Git project or a managed workspace containing
Git projects. A1 watches the project itself or discovers projects below that workspace (excluding
dependency and build-cache directories). This supports a simple layout such as `~/Documents/A1` for
the A1 source and `~/Documents/A1-Projects/<project>` for every other managed project. Ordinary
folders outside these declared workspaces remain outside the rule.

The worker sends a heartbeat with the Git branch, a **content-aware source fingerprint**, and
changed-file counts for each discovered project. The fingerprint includes tracked and non-ignored
source-file contents, so changing an already-modified file creates a new review requirement. A1
automatically queues a fresh `project.verify` when that fingerprint changes. Project verification
runs the project's `npm run verify` script when present, then falls back to `npm test` or
`git diff --check`.

## Default code gate and physical stop

Every watched project is default-deny for A1 write-capable commands. A project becomes
write-authorized only when **both** of these apply to its exact current source fingerprint:

1. Its deterministic project verification passed.
2. The dedicated `code-watchdog` agent recorded an `approved` decision.

`unverified`, `queued`, `running`, `failed`, `fix_required`, and `blocked` all reject A1-initiated
shell writes and deployments inside that project. A changed fingerprint immediately loses the
previous approval. The worker always reports its post-verification fingerprint, so it cannot
accidentally pass the code that was present before a concurrent edit.

For a `blocked` decision, A1 also cancels queued worker writes in that project and places a priority
`project.lock` command ahead of ordinary work. The worker records original POSIX file modes in the
external lock directory and removes write permissions from tracked and non-ignored source files plus
their source directories. This physically stops normal A1 and user processes from editing the source
tree until an explicit, approval-gated unlock restores the recorded modes.

This is a reversible operational safety lock, not an unbreakable security boundary: the owner of the
machine (or root) can manually change file permissions. Do not set the lock directory inside a
managed project; it must remain accessible while the project is locked. Repairs should be prepared
in a separate worktree, reviewed there, then applied only after an explicit unlock.

`shell` commands are disabled by default. They require `A1_WORKER_ALLOW_SHELL=true`, must provide a
working directory inside a watched project root, and are still recorded in A1's audit trail. The
central code gate applies even after shell has been enabled. Enable it only after the worker path
scope has been reviewed.

## Concierge and Vast

The Concierge can inspect workers, queue code verification, and track results after the configured
worker permissions are enabled. It uses the existing Vast API provider for instance lifecycle
actions; provisioning or release remains approval-gated. Once the Vast worker is enrolled, scoped
changes inside an already-running GPU environment travel through the same queue as M1 and Intel
commands.
