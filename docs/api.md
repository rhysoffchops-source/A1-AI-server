# HTTP API

All management routes are under `/api/v1`. When authentication is enabled, send a bearer token with
the required permission. JSON request bodies are size-limited and validated before use.

| Method   | Route                                        | Permission               | Purpose                         |
| -------- | -------------------------------------------- | ------------------------ | ------------------------------- |
| `GET`    | `/health/live`                               | Public                   | Process liveness                |
| `GET`    | `/health/ready`                              | Public                   | Dependency readiness            |
| `GET`    | `/metrics`                                   | Public                   | Prometheus metrics              |
| `GET`    | `/api/v1/dashboard`                          | `dashboard:read`         | Aggregated operational snapshot |
| `GET`    | `/api/v1/events`                             | `events:read`            | Server-Sent Event stream        |
| `GET`    | `/api/v1/tasks`                              | `task:read`              | Recent tasks                    |
| `GET`    | `/api/v1/tasks/:id`                          | `task:read`              | Task state and result           |
| `DELETE` | `/api/v1/tasks/:id`                          | `task:cancel`            | Approval-gated cancellation     |
| `POST`   | `/api/v1/agents/runs`                        | `agent:run`              | Queue a durable agent run       |
| `GET`    | `/api/v1/workers`                            | `worker:read`            | List enrolled machines          |
| `GET`    | `/api/v1/workers/:workerId/commands`         | `worker:read`            | List worker commands            |
| `POST`   | `/api/v1/workers/:workerId/commands`         | `worker:execute`         | Queue a scoped check or shell   |
| `GET`    | `/api/v1/code-verification`                  | `worker:read`            | Read code-gate state            |
| `POST`   | `/api/v1/code-verification/:workerId/unlock` | `code:unlock` + approval | Queue an explicit lock restore  |
| `GET`    | `/api/v1/projects`                           | `project:read`           | List projects                   |
| `POST`   | `/api/v1/projects`                           | `project:create`         | Register a project              |
| `GET`    | `/api/v1/memory/search?q=`                   | `memory:read`            | Search persistent memory        |
| `GET`    | `/api/v1/backups`                            | `backup:read`            | List backup manifests           |
| `POST`   | `/api/v1/backups`                            | `backup:create`          | Create a consistent backup      |
| `POST`   | `/api/v1/approvals`                          | `approval:issue`         | Issue a bound approval          |
| `GET`    | `/api/v1/compute/:provider/instances/:id`    | `compute:read`           | Observe remote compute          |
| `POST`   | `/api/v1/compute/:provider/instances`        | `compute:provision`      | Provision approved compute      |
| `DELETE` | `/api/v1/compute/:provider/instances/:id`    | `compute:release`        | Release approved compute        |

An approval response must be supplied unchanged in the destructive request body as `approval`.
Approvals are single-use, expire, and are cryptographically bound to their action and target.

Worker callbacks under `/api/v1/workers/:workerId/...` use a distinct per-worker `Worker` token
rather than a dashboard bearer token. The Code Watchdog records `approved`, `fix_required`, or
`blocked` against an exact source fingerprint. A blocked project rejects A1 writes and queues a
reversible local source-tree lock. Unlocking requires a separately issued approval with action
`code.unlock` and target `<workerId>:<absolute-project-path>`.
