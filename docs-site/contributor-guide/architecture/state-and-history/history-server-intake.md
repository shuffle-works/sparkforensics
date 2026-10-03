# History Server intake and recovery

How the drop zone fetches a run from a History Server and recovers from errors.

`DropZone` keeps the History Server disclosure, Base URL, Application ID,
optional Attempt ID, validation/touched state, recoverable SHS error, and
local-server reachability in mounted React state rather than Zustand. The
local browser-first path is the default: **Choose file** loads a single
event log, while **Choose rolling-log folder** accepts only an
`eventlog_v2_*` directory and directs a rejected folder back to the file
picker.

The three text fields also mirror to `window.localStorage`
(`shuffle-works-shs-base-url`/`-app-id`/`-attempt-id`), read back as each
`useState`'s initializer, so a returning visitor's values survive a reload;
storage access is wrapped in try/catch and silently ignored when unavailable,
matching `store.ts`'s `initialTheme`/`initialWidgetDensity` pattern. Both this
disclosure's toggle and the **Other sources** toggle show a chevron
(`ChevronDownIcon`/`ChevronUpIcon`) that flips with `aria-expanded`, so the
open/closed state has a visual signal beyond the attribute.

On mount (skipped in `compact` mode), `DropZone` probes reachability with an
empty, short-timeout `fetch('/shs-proxy')`: a 400 means `validateShsRequest`
(`packages/core/src/proxy.js`) rejected the empty request synchronously,
which only happens when a local server is actually routing that path, so it
flips `shsReachable` to `true`. A network error, a 404 (static deploy, no
such route), or a probe still in flight all leave `shsReachable` at its
default `false`, so nothing changes on screen after paint unless the server
is confirmed present. When `shsReachable` is `true`, the landing page shows a
neutral callout above the **Other sources** disclosure pointing the user at
it; the disclosure itself doesn't move or auto-expand.

The collapsed **Fetch from Spark History Server** disclosure requires
local-server mode, a reachable History Server, and a supported base application
ID: `application_<timestamp>_<id>`, `local-<timestamp>`, `app-<identifier>`,
`spark-<identifier>` or `driver-<number>` (`APP_ID_PATTERNS` in
`packages/core/src/shs-request.js`). `packages/core/src/shs-request.js` trims and validates the three
request fields, accepts only absolute credential-free `http:`/`https:` base
URLs without a query or fragment, preserves a reverse-proxy path prefix, and
canonicalizes the base URL to one trailing slash. The optional attempt is a
separate path-safe identifier; neither identifier can contain a path separator.
The shared helper builds the encoded `/shs-proxy` request and the encoded
`api/v1/applications/<app>[/<attempt>]/logs` upstream path from that normalized
object only.

The optional Node server is loopback-only: a narrow CORS proxy, not a
general or hosted proxy. It validates the same request contract, sends no
credentials, follows no upstream redirects, and returns only stable safe error
codes. It never forwards upstream response text, status details, locations, or
credentials to the browser.

Routing preserves the recovery boundary: local file and folder failures use the
page-level error route. A typed SHS failure instead resets the model
to idle and returns to the still-mounted, expanded History Server disclosure,
which retains its values and shows safe recovery guidance along with local
file intake. During an SHS parse, the mounted intake shows progress in place;
successful completion follows the normal dashboard route.
