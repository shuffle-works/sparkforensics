# Product: SparkForensics

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are Spark developers diagnosing and improving application performance. The default view is designed for the least experienced of them: someone new to Spark tuning, who should be able to tell what they are looking at, what matters most, and what to do next without prior knowledge. Experts and performance engineers, especially when an investigation spans stages, executors, SQL plans, configuration, and whole-run behavior, get the deeper detail through Advanced view rather than in the default view.

## Product Purpose

SparkForensics turns Spark History event logs into actionable performance analysis. It helps users understand application behavior, locate bottlenecks, inspect the affected stages, and evaluate optimization opportunities without manually reconstructing the run from raw NDJSON events.

Success for this component means giving users useful findings from many analytical angles in a responsive, interactive browser interface.

## Positioning

Within the wider Spark Optimization project, this component is the interactive web visualizer. It combines a broad roster of detectors and report lenses with private browser-local analysis, rather than being only a raw event-log viewer.

This repository implements a static browser application and an optional local Node server that proxies Spark History Server requests. Broader product interfaces and commercialization choices are outside this component record.

## Workspace Context

This repository is now self-contained (no parent-workspace superproject); it
no longer carries shared cross-repo architecture, integration, or
commercialization documents. Broader product direction, CLI/automation/
agent-interface plans, and packaging or licensing choices are out of scope
for this record.

## Operating Context

Users investigate completed Spark applications from Spark event logs. In the browser workflow they drop or choose a single log, choose a rolling `eventlog_v2_*` directory, revisit a recent file, or, when running the local-server deployment, fetch an application from a Spark History Server by base URL and application ID.

The dashboard starts with a health scorecard and flagged findings for fast triage, then stage-level detail, configuration and SQL-plan advice, and report lenses for deeper performance work.

## Capabilities and Constraints

- Parse large Spark History NDJSON event logs and supported compressed or rolling-log formats without placing raw task-event data on the browser main thread.
- Keep the primary static deployment zero-backend; use the optional local server only when server-to-server Spark History access is needed to avoid browser CORS restrictions.
- Analyze applications from multiple angles, including stage, application, SQL-plan, and configuration findings plus whole-run report lenses.
- Flag every affected stage and keep rendered analysis domain-agnostic.
- Treat detector thresholds in `src/detectors.js` and the architecture contract in `docs-site/contributor-guide/architecture/detector-contract.md` as product behavior that must not drift casually.
- Preserve privacy as a product constraint. Local workflows should allow sensitive event logs to remain in the user's environment.
- Keep workspace-wide interface, packaging, and licensing decisions out of this component record; see Workspace Context.

## Brand Commitments

The current product name is **SparkForensics**. Product language should remain technical, direct, and domain-agnostic. It must not introduce company-, industry-, or dataset-specific assumptions into rendered analysis.

## Evidence on Hand

- `README.md` documents the static browser and optional local-server workflows, supported inputs, and deployment constraints.
- The [worker protocol](../docs-site/contributor-guide/architecture/worker-protocol.md), [detector contract](../docs-site/contributor-guide/architecture/detector-contract.md), [dashboard sequence](../docs-site/contributor-guide/architecture/widget-rendering.md), and [large-log performance invariant](../docs-site/contributor-guide/architecture/overview.md#core-invariant) are documented in `docs-site/contributor-guide/architecture/`.
- `src/detectors.js` and the React widgets under `src/view/` implement the bottleneck findings and analysis lenses.
- Example Spark event logs under `examples/` are used for smoke and streaming-path testing.
- No testimonials, customer claims, adoption metrics, or benchmark claims were established. Future work must not fabricate them.

## Product Principles

1. **Insight breadth with practical depth.** Combine complementary detectors and report lenses, then connect findings to the stages and evidence users need to act.
2. **Privacy by deployment choice.** Keep local analysis viable so event logs do not need to leave the user's environment.
3. **Large logs must remain usable.** Keep streaming and off-main-thread processing a product capability, not an implementation detail to trade away.
4. **Remain browser-first.** Keep the static, zero-backend experience; keep the optional local server a narrow integration mode rather than a mandatory backend.
5. **Respect component boundaries.** Keep the visualizer focused on interactive diagnostics and integrate with shared project capabilities through documented contracts.
