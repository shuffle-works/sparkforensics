# What stays on your machine

The browser app parses your event log in a Web Worker on your machine. The
log's contents are never sent anywhere. The app's pages enforce this with a
Content-Security-Policy that limits every request the page can make
(`fetch`, WebSocket, beacon) to the origin that served it.

## Which modes contact the network

| Mode | Network use |
| --- | --- |
| Browser app, dropped or picked file | None beyond loading the app from the host that serves it. |
| **Try a sample run** | One request to the same host for the bundled sample log. |
| Docs panel | The panel is an iframe that loads pages from the same host's `/docs/`. |
| Local server (`sparkforensics-server`) | The browser talks only to the local server. When you fetch from a Spark History Server, the server makes that request, not the browser. The server listens on `127.0.0.1` only. |
| CLI and MCP tools with a log path | None. |
| CLI and MCP tools with a History Server URL | One request to that server for the event log. |

Links to other sites open only when you click them.

## Check it yourself

Open your browser's developer tools, load a log, and look at the Network tab:
every request goes to the page's own origin. The policy is the
`Content-Security-Policy` meta tag in the app's `index.html`, and a browser
test (`npm run test:e2e`) fails on any other origin.

## `--redact` is not a network control

`--redact` on the CLI and MCP tools pseudonymizes the application ID,
application name and host names in the output, so you can share a report.
It does not change which requests a mode makes.
