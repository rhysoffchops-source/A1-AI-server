# MCP operations

A1 speaks MCP over stdio and Streamable HTTP. Server identity, executable or URL, arguments,
environment, headers, timeouts, enabled state, and required permissions are strict YAML fields under
`mcp.servers`.

The registry is capability-neutral. Filesystem, Git, GitHub, SQLite, Postgres, Docker, terminal,
browser, PDF, HTTP, Slack, Notion, Google Drive, and S3 servers use the same lifecycle and
invocation path. A custom MCP server requires only another YAML entry.

Startup fails closed when a server declares a permission absent from `mcp.grantedPermissions`.
Enabled processes are initialized in configuration order and closed in reverse order. Tools are
always addressed by both server ID and tool name, preventing cross-server name collisions.

Environment and header values that contain credentials use `secret://handle`, which is resolved at
composition time. For example, `Authorization: secret://github.authorization` resolves from
`A1_SECRET_GITHUB_AUTHORIZATION`. Secret values must not be committed to YAML.
