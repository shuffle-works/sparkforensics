# sparkforensics-mcp

MCP server exposing Apache Spark event-log diagnostics over stdio.

```bash
npx sparkforensics-mcp
```

Point your MCP client at that command. For Claude Desktop or Claude Code, add
this to its MCP config:

```json
{
  "mcpServers": {
    "sparkforensics": {
      "command": "npx",
      "args": ["sparkforensics-mcp"]
    }
  }
}
```

See the [MCP tools reference](https://shuffle-works.github.io/sparkforensics/docs/user-guide/mcp-tools)
for every tool and its parameters.
