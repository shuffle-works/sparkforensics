# Vision

`sparkforensics` exists so that a Spark developer with a slow or failing run can learn why, and what to change, from the run's own logs.
It serves Spark developers, and its default view is written for the least experienced of them; performance engineers get the deeper detail through Advanced view.
It turns a Spark History event log, or a baseline and a candidate, into ranked findings with evidence, an honest estimate of what each fix is worth, and a specific remediation.
It owns exactly one thing: the diagnosis of a Spark run from its logs.

## The log stays with its owner

The log never goes to a third party.
Analysis runs where the log already is: a browser tab, a local CLI, a local MCP server, or later a team server the user hosts on their own network.
Nothing installs on the cluster, and the static app and the CLI need no account, upload or backend.
The optional local server exists to reach a Spark History Server past CORS, and it binds to localhost.
Outside data that needs a network call, such as live cloud prices, comes in only when users need it, and is a candidate for a plugin so the core stays offline.
A privacy claim is backed by a check a user or CI can run, such as the same-origin content security policy and the no-network browser test.
Every field that leaves the analysis has a stated redaction policy, and `--redact` covers the dashboard export, the CLI and MCP alike.
An LLM explanation of a run belongs to the agent the user connects through MCP, so the app makes no model calls of its own.
Built-in output names no company, industry or dataset of the user; a plugin may use its own team's names for tables, jobs and owners.
A platform-specific finding, such as one for Databricks or EMR, is welcome when the log identifies the platform.

## A finding is right before it is new

A finding states only what the log proves, and it says what it could not confirm.
A cause is named only when the log holds evidence for it; a plausible guess stays out, even with a low confidence grade.
Silence beats a wrong flag.
Detectors judge each run against the Spark version and configuration that actually applied to it, including per-query settings, never against textbook defaults.
A finding that contradicts how Spark behaves is removed, not reworded.
An estimate says what it measures: wall-clock savings, core time, modeled cost and dollars never share a unit or a format, and a dollar figure states its price assumptions.
Findings are ordered by estimated impact on the run, so the top row is the fix worth doing first.
Built-in detector thresholds are frozen product behavior; a change to one is deliberate, and the corpus snapshot records every intended finding change.
A new built-in detector is welcome when it names a cause and a fix that the catalog does not already cover.
Third-party detectors are welcome through a plugin API, and their findings reach every surface through the same core analysis.
A prediction, such as an interactive what-if panel, ships only when it is accurate enough to act on.

## One analysis, every surface

Analysis is computed once in core, and the dashboard, the HTML export, the CLI and MCP all read that one result.
The dashboard only renders.
A feature that needs stored run history, such as a trend panel, may exist only on the team server, and the static app keeps everything it has today.
A public field is added once, in a shared core builder, and the parity test fails on a field that only one surface has.
Remediation can leave in any machine-readable form, such as a config fragment for spark-submit, because an export is one more view of the same result.
CLI and MCP outputs are one public contract.
Before 1.0, a breaking change ships as one coordinated release whose changesets name each removal and its replacement, with no deprecation window.
After 1.0, a renamed or removed public field gets a deprecation window.
Generated content, such as the detector catalog pages and the tuning chapters, comes from its source and is never edited by hand.

## Fix the cause where the value is decided

A wrong output is fixed in the code that decides it, from its data, never by observing rendered output and correcting it afterwards.
Structural guards in lint and tests make the rejected patterns impossible to land, rather than relying on review to catch them.
A run comparison explains why the time moved before it calls a change a regression.
Slower is not worse until the comparison rules out capacity, configuration and plan.
Large logs stay usable: parsing streams off the main thread, and analysis scales linearly with log size.

## Scope

`sparkforensics` is not a cluster monitor, not a scheduler, and not a third-party hosted service.
It does not run Spark.
It does not change a job or apply a fix; it tells the reader what to change and why, and applying a change stays with the user or with automation such as the Airflow operator, which lives in its own repository.
It diagnoses completed runs today; diagnosing a run in progress is a possible later step, held to the same evidence rule.
It reads Spark History event logs today; another Spark log format, such as a query profile or a Spark Connect log, joins when users ask for it.
What the default view shows or hides follows user reports about the view, not a fixed rule.
Tuning knowledge lives in the pinned tuning reference, and a fix to it lands upstream first.
Private logs never enter this public repository; tests use the public corpus and synthetic application IDs.

A change aligns when it makes a finding more correct, more honest about its evidence, or more actionable, computed once in core and shown the same way on every surface, while the log stays on infrastructure its owner controls.
A change should be resisted when it sends log data to a third party, makes the static app depend on a backend, computes analysis in a view, corrects rendered output after the fact, gives the CLI and MCP different fields, or names a cause the log cannot support.
