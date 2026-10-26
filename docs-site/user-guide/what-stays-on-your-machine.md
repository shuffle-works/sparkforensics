# What stays on your machine

The browser app parses your event log in a Web Worker on your machine. The
log's contents are never sent anywhere. The app page has a
Content-Security-Policy that limits the page's own requests (`fetch`,
WebSocket, beacon) to the origin that served it. The policy does not cover
the parse, zstd and layout workers or the docs iframe. A test does.

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
`Content-Security-Policy` meta tag in the app's `index.html`. The browser
test `e2e/no-network.test.js` (`npm run test:e2e`) loads the sample run and
the docs panel, and fails on any request from the page, its workers or the
iframe to another origin.

## `--redact` is not a network control

`--redact` on the CLI and MCP tools pseudonymizes the application ID,
application name and host names in the output, so you can share a report.
It does not change which requests a mode makes.
