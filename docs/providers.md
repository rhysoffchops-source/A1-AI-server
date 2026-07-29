# Provider configuration

## Models

Model providers and model catalog entries are independent. A provider supplies transport; catalog
entries describe routing policy. `openai-compatible` supports OpenAI, OpenRouter, Venice, Ollama,
vLLM, llama.cpp, MLX, and future compatible endpoints. Anthropic and Gemini use native adapters.
Credentials are named by `apiKeySecret`.

Provider-specific authentication headers can be passed without storing values in YAML through
`headerSecrets`. Map each HTTP header name to its secret handle; for example, Modal endpoints use
`Modal-Key: modal.proxy-token-id` and `Modal-Secret: modal.proxy-token-secret`. A1 resolves those
handles from `A1_SECRET_MODAL_PROXY_TOKEN_ID` and `A1_SECRET_MODAL_PROXY_TOKEN_SECRET`.

Routing filters by required capabilities, context size, requested model/provider, and enabled state.
It prefers the requested local/cloud location, then priority, and falls through candidates when an
adapter fails.

## Storage

Use `local` or `s3`. The S3 adapter supports AWS S3, Backblaze B2, Cloudflare R2, and custom
S3-compatible endpoints through `endpoint`, `region`, and `forcePathStyle`. Access and secret keys
must both be present or both be omitted for the platform credential chain.

## MCP

Every MCP server is declared in `mcp.servers` with `stdio` or `http` transport. A1 has no
integration-specific branches: filesystem, Git, GitHub, SQLite, Postgres, Docker, terminal, browser,
PDF, HTTP, Slack, Notion, Google Drive, S3, and custom servers are registrations of the same
transport contract. See [mcp.md](mcp.md).

## Compute

The compute port owns provision, observe, and release. The included Vast.ai adapter uses its REST
API and is selected by YAML. Remote command execution is a separate SSH adapter so either side can
be replaced independently.
