# node-mcp-proxy

Small STDIO-to-Streamable-HTTP MCP bridge for clients like Claude Desktop.

This is intentionally narrower than `mcp-remote`:

- no OAuth flow
- no SSE fallback
- no standalone `GET` used to establish a stream
- request forwarding happens with `POST` only

That makes it useful for MCP servers that support Streamable HTTP responses on `POST` but do not expose the optional standalone `GET` SSE endpoint.

## Install

```bash
npm install
```

The project is set up to run on Node 14+.

## Usage

```bash
node ./src/cli.js https://remote.mcp.server/mcp
```

Windows PowerShell:

```powershell
node .\src\cli.js https://remote.mcp.server/mcp
```

Windows Command Prompt:

```bat
node .\src\cli.js https://remote.mcp.server/mcp
```

When you run the command directly in a shell, it will usually appear to do nothing.
That is expected: this program is a stdio bridge, so it waits for MCP JSON-RPC messages on stdin from a client such as Claude Desktop.

If you want visible logs while it is waiting, add `--debug`:

```bash
node ./src/cli.js https://remote.mcp.server/mcp --debug
```

Windows PowerShell:

```powershell
node .\src\cli.js https://remote.mcp.server/mcp --debug
```

If you want to smoke-test it manually from a shell, pipe in an MCP `initialize` request:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-test","version":"1.0.0"}}}' | node ./src/cli.js https://remote.mcp.server/mcp --header "Authorization: Bearer ${AUTH_TOKEN}" --debug
```

Windows PowerShell:

```powershell
$env:AUTH_TOKEN = 'YOUR_OAUTH_TOKEN'
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-test","version":"1.0.0"}}}' | node .\src\cli.js https://remote.mcp.server/mcp --header "Authorization: Bearer ${AUTH_TOKEN}" --debug
```

Windows Command Prompt:

```bat
set AUTH_TOKEN=YOUR_OAUTH_TOKEN
echo {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-test","version":"1.0.0"}}} | node .\src\cli.js https://remote.mcp.server/mcp --header "Authorization: Bearer ${AUTH_TOKEN}" --debug
```

### Flags

- `--header "Name: Value"` adds a header to every remote request. Repeat as needed.
- `--allow-http` allows `http://` URLs.
- `--debug` writes bridge logs to stderr.

Environment variables in header values are expanded with `${NAME}`.

## Claude Desktop config

On macOS, Claude Desktop typically reads:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

On Windows, Claude Desktop typically reads:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "node",
      "args": [
        "/absolute/path/to/node-mcp-proxy/src/cli.js",
        "https://remote.mcp.server/mcp",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}"
      ],
      "env": {
        "AUTH_TOKEN": "replace-me"
      }
    }
  }
}
```

Replace `/absolute/path/to/node-mcp-proxy/src/cli.js` with the actual absolute path on the machine where Claude Desktop is running.
Do not use the example path verbatim.

Windows example:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "node",
      "args": [
        "C:\\absolute\\path\\to\\node-mcp-proxy\\src\\cli.js",
        "https://remote.mcp.server/mcp",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}",
        "--debug"
      ],
      "env": {
        "AUTH_TOKEN": "replace-me"
      }
    }
  }
}
```

Replace `C:\\absolute\\path\\to\\node-mcp-proxy\\src\\cli.js` with the actual absolute path on the Windows machine where Claude Desktop is running.

If the user has installed this project as a global command, they can avoid the script path entirely:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "node-mcp-proxy",
      "args": [
        "https://remote.mcp.server/mcp",
        "--header",
        "Authorization: Bearer ${AUTH_TOKEN}"
      ],
      "env": {
        "AUTH_TOKEN": "replace-me"
      }
    }
  }
}
```

That only works if `node-mcp-proxy` is already on the user's `PATH`.

For HTTP servers inside a trusted network:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "node",
      "args": [
        "/absolute/path/to/node-mcp-proxy/src/cli.js",
        "http://internal.example/mcp",
        "--allow-http"
      ]
    }
  }
}
```

## Behavior notes

- Incoming STDIO JSON-RPC is forwarded to the remote endpoint as HTTP `POST`.
- If the remote response is `text/event-stream`, each JSON payload from `data:` lines is forwarded back over STDIO.
- If the remote response is `application/json`, that payload is forwarded directly.
- Session IDs returned in `mcp-session-id` are reused on later requests.
- The negotiated protocol version from `initialize` is sent as `mcp-protocol-version` on later requests.
