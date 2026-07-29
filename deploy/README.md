# A1 deployment kit

These scripts prepare the four pieces of the A1 system without opening a public model API:

```text
VPS:     A1 dashboard, Concierge, scheduler, SQLite state, Code Watchdog dispatcher
Modal:   one authenticated, scale-to-zero Qwen 27B Code Watchdog endpoint
Vast:    one disposable GPU worker with a local model cache / attached Vast volume
M1/Intel: enrolled A1 workers and local/remote model clients
```

Secrets are never placed in YAML or committed files. All scripts use a dry run by default and
require `--apply` before creating infrastructure or changing a server.

## 1. Private mesh first

Install Tailscale on the VPS, M1, and Intel and connect each to the same tailnet. On the two Linux
machines, run the shared script as root. It prints a login URL if no auth key is supplied.

```bash
sudo A1_TAILSCALE_HOSTNAME=a1-vps \
  A1_TAILSCALE_SERVE_TARGET=http://127.0.0.1:8787 \
  bash deploy/tailscale/connect-linux.sh

sudo A1_TAILSCALE_HOSTNAME=a1-intel bash deploy/tailscale/connect-linux.sh
```

Do the M1 login in the Tailscale macOS app. Do not use Tailscale Funnel. Once the VPS dashboard is
running, rerun the VPS command with `A1_TAILSCALE_SERVE_TARGET` to expose it privately using
Tailscale Serve. The first Serve call may ask you to approve HTTPS for the tailnet.

For Vast, generate a **tagged, pre-authorized, ephemeral** auth key in the Tailscale admin console.
Give it the narrow worker tag you will allow in your tailnet ACL (for example `tag:a1-worker`). Do
not reuse that key for the VPS, M1, or Intel. Tailscale supports ephemeral auth keys specifically
for short-lived nodes.
[Auth-key documentation](https://tailscale.com/docs/features/access-control/auth-keys)

## 2. Create the Modal Code Watchdog

Set an account spending alert/limit first. Modal endpoints scale to zero when idle, but account
billing guardrails live in Modal rather than this repository. Then run the script from the
authenticated Modal CLI profile:

```bash
MODAL_ENVIRONMENT=a1 bash deploy/modal/create-code-watchdog.sh --apply
```

It creates the authenticated `Qwen/Qwen3.6-27B-FP8` endpoint. Retrieve the endpoint `/v1` URL,
create a dedicated Modal proxy token pair, and keep the pair for the VPS `runtime.env` file. The
endpoint must remain authenticated; Modal uses `Modal-Key` and `Modal-Secret` headers for that token
pair. [Modal endpoint guide](https://modal.com/docs/guide/endpoints)

## 3. Prepare and deploy the VPS

Copy the A1 source repository to the VPS first. On an Ubuntu/Debian VPS, the optional bootstrap
installs the package-manager Docker build and tools:

```bash
sudo bash deploy/vps/bootstrap.sh --apply
```

Create the protected runtime file and fill it with real values. It must remain local to the VPS.

```bash
install -d -m 700 deploy/runtime
cp deploy/vps/runtime.env.example deploy/runtime/runtime.env
chmod 600 deploy/runtime/runtime.env
```

The control plane needs the Modal endpoint URL and a future M1 Concierge endpoint URL. An
unavailable M1 provider does not stop the dashboard or Code Watchdog from starting, but Concierge
chat will only answer after the M1 endpoint is live.

```bash
A1_MODAL_WATCHDOG_BASE_URL=https://<modal-endpoint>/v1 \
A1_CONCIERGE_BASE_URL=https://<m1-tailnet-endpoint>/v1 \
A1_ENABLE_VAST=false \
  bash deploy/vps/deploy.sh --apply
```

The Docker port remains bound to `127.0.0.1:8787`; Tailscale Serve is the only intended remote path.
The dashboard has an **Access token** button where you paste an administrator bearer token. Issue a
short-lived one on the VPS with `bash deploy/vps/issue-admin-token.sh`; never put it in a URL or
browser local-storage sync service.

Before starting a worker, add it to the rendered `deploy/runtime/production.yaml`
`workers.definitions` array, create its distinct token in `deploy/runtime/runtime.env`, and rerun
`deploy/vps/deploy.sh --apply`. Each project's allowed root should be a deliberately managed A1
workspace, not a whole home directory.

## 4. Rent and bootstrap Vast

Use the Vast dashboard or CLI to choose an offer first. Check its live hourly price, GPU VRAM,
reliability, local-disk size, and whether the existing Vast volume can attach to that host. The
script does not make that economic choice for you:

```bash
A1_VAST_API_KEY=... \
A1_VAST_OFFER_ID=<chosen-offer-id> \
A1_VAST_DISK_GB=500 \
A1_VAST_VOLUME_ID=<optional-existing-volume-id> \
  bash deploy/vast/provision.sh --apply
```

Vast attaches an existing volume through `volume_info`; the GPU's local disk is still separate. Keep
active model weights and cache on the attached/selected Vast storage, while the VPS retains A1
state, database, audit log, and secrets.
[Vast instance-create API](https://docs.vast.ai/api-reference/instances/create-instance)

After inspecting and pinning the new SSH host key in a dedicated known-hosts file, bootstrap it:

```bash
A1_VAST_SSH_HOST=<ssh-host> \
A1_VAST_SSH_PORT=<ssh-port> \
A1_VAST_KNOWN_HOSTS_FILE=<absolute-pinned-known-hosts-file> \
A1_VAST_TAILSCALE_AUTH_KEY=<tagged-ephemeral-key> \
A1_WORKER_CONTROL_URL=https://a1-vps.<tailnet>.ts.net \
A1_WORKER_TOKEN=<vast-worker-token> \
  bash deploy/vast/bootstrap.sh --apply
```

Then SSH through the pinned host and start one private vLLM model:

```bash
A1_VAST_MODEL_ID=<chosen-model-id> \
A1_VAST_MODEL_API_KEY=<different-long-random-key> \
  sudo bash /opt/a1/start-vllm.sh --apply
```

vLLM binds to loopback and is exposed only with Tailscale Serve. Configure M1 or A1 to call the
printed tailnet HTTPS `/v1` URL with its separate model bearer key. Never use the Vast public port
for model inference.

## Code-gate consequence

Once workers are enrolled, every Git project under their managed A1 workspace is default-deny for A1
writes. The current source fingerprint must pass deterministic checks and receive the Modal Code
Watchdog approval. A `blocked` decision cancels queued A1 writes and asks that machine to apply its
reversible source-tree permission lock. See [workers.md](../docs/workers.md) for the exact protocol.
