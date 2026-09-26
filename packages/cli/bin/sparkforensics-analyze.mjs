#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  writeFileSync, existsSync, realpathSync,
  mkdtempSync, mkdirSync, rmSync, renameSync, readdirSync, cpSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(binDir);

// vendor-core/ exists only in a published install (populated by vendor-core.mjs
// at pack time); the monorepo falls back to the packages/core/src/ sibling.
// load-vendored.js is the one module located by hand; the rest load through its
// exported loadVendored().
const vendoredHelper = join(pkgDir, 'vendor-core', 'load-vendored.js');
const helperPath = existsSync(vendoredHelper) ? vendoredHelper : join(pkgDir, '..', 'core', 'src', 'load-vendored.js');
const { loadVendored } = await import(pathToFileURL(helperPath).href);
const loadCore = (moduleName) => loadVendored(pkgDir, moduleName);

const { collectRun } = await loadCore('cli/collect-run');
const { resolveFromShs } = await loadCore('shs-load');
const { analyze } = await loadCore('analyzer');
const { deriveEvidenceAvailability } = await loadCore('evidence-availability');
const { buildEvidenceReport, toFindingsFilter } = await loadCore('evidence-report');
const { evaluateBudgets } = await loadCore('cli/budgets');
const { buildComparison, renderComparisonMarkdown, COMPARISON_METRIC_KEYS } = await loadCore('run-comparison');
const { redactComparison } = await loadCore('redact');
const { buildHtmlExportData, runPayloadScript } = await loadCore('html-export');

const USAGE = `Usage: sparkforensics-analyze <event-log-file|rolling-log-dir> [options]
       sparkforensics-analyze --shs-base-url <url> --app-id <id> [--attempt-id <id>] [options]

Options:
  --format md|json                 Output format (default: json).
  --out <path>                    Write output to a file instead of stdout.
  --export-html <dir>              Write a self-contained HTML dashboard for this run into <dir>
                                    (must not exist or be empty). Open <dir>/index.html directly, no
                                    server required. Can be combined with --format/--out, which write
                                    their own separate output unchanged.
  --max-runtime <ms>               Fail if app runtime exceeds this many ms.
  --max-spill <gb>                  Fail if any stage spills more than this many GB.
  --max-skew <ratio>                Fail if any stage's P95/median duration ratio exceeds this.
  --max-failed-task-rate <pct>      Fail if the task failure rate exceeds this percent.
  --min-efficiency <pct>            Fail if compute efficiency falls below this percent.
  --shs-base-url <url>              Fetch the run from a Spark History Server instead of a
                                    local file (mutually exclusive with the positional argument).
  --app-id <id>                     Spark application ID to fetch. Required with --shs-base-url.
  --attempt-id <id>                 Optional attempt ID, used with --shs-base-url.
  --baseline <path>                 Compare the run against a baseline local event-log file or
                                    rolling-log directory. Baseline is local-path-only (no SHS
                                    support). Adds a comparison section to the output.
  --max-regression-pct <pct>        Requires --baseline. Fail if the regression metric (see
                                    --regression-metric) regressed by more than this percent.
  --regression-metric <key>         Metric key to check with --max-regression-pct (default:
                                    wallClock). Requires --baseline and --max-regression-pct.
  --fail-on-introduced <band|all>   Requires --baseline. Fail if any finding was introduced by
                                    the candidate matching this impact band (or any, with "all").
  --redact                          Pseudonymize the app id and any host/IP tokens in the output
                                    (app-1, host-1, ...), so a report can be shared outside the
                                    environment that produced it.
  --impact <band[,band]>            Filter the output's findings array to these impact bands
                                    (critical, warning, info). recommendations/cleanChecks and
                                    the summary counts stay on the full, unfiltered set.
  --type <type[,type]>              Filter the output's findings array to these finding types.
  --stage <id>                      Filter the output's findings array to this stage id.

Exit codes: 0 pass, 1 budget violated, 2 bad arguments, the local input could not be parsed, or the --shs-base-url fetch failed, 3 a budget was inconclusive.
`;

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      format: { type: 'string' },
      'max-runtime': { type: 'string' },
      'max-spill': { type: 'string' },
      'max-skew': { type: 'string' },
      'max-failed-task-rate': { type: 'string' },
      'min-efficiency': { type: 'string' },
      'shs-base-url': { type: 'string' },
      'app-id': { type: 'string' },
      'attempt-id': { type: 'string' },
      baseline: { type: 'string' },
      'max-regression-pct': { type: 'string' },
      'regression-metric': { type: 'string' },
      'fail-on-introduced': { type: 'string' },
      redact: { type: 'boolean' },
      'export-html': { type: 'string' },
      impact: { type: 'string' },
      type: { type: 'string' },
      stage: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  return { values, positionals };
}

function bail(message, code) {
  process.stderr.write(message);
  process.exitCode = code;
}

function splitCsv(value) {
  if (value === undefined) return undefined;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

async function collectWithEvidence(path) {
  const { appModel, skippedLines } = await collectRun(path);
  appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
  return { appModel, skippedLines };
}

async function writeHtmlExport(destDir, appModel, catalog, skippedLines, { redact }) {
  const exportData = buildHtmlExportData(appModel, catalog, skippedLines, { redact });

  // Published install: packages/cli/export-template/ (populated by
  // scripts/vendor-export-template.mjs at prepack time). Monorepo dev mode:
  // fall back to the repo-root dist-export/ build output directly, same
  // fallback pattern as loadCore()'s vendor-core/ -> core/src/ resolution.
  const vendoredTemplate = join(pkgDir, 'export-template');
  const templateDir = existsSync(vendoredTemplate) ? vendoredTemplate : join(pkgDir, '..', '..', 'dist-export');
  if (!existsSync(templateDir)) {
    throw new Error(`export template not found at ${templateDir} (run \`npm run build:export\` first)`);
  }

  const parentDir = dirname(destDir);
  mkdirSync(parentDir, { recursive: true });
  const tempDir = mkdtempSync(join(parentDir, '.sparkforensics-export-'));
  try {
    cpSync(templateDir, tempDir, { recursive: true });
    // gzip + base64 to shrink the artifact; decodeRunPayload (hydrate-store.ts)
    // reverses it. runPayloadScript explains why base64 needs no escaping.
    const json = JSON.stringify(exportData);
    const base64 = gzipSync(json).toString('base64');
    writeFileSync(join(tempDir, 'data.js'), `${runPayloadScript(base64)}\n`);
    // Clear destDir (confirmed empty-or-absent by the caller) right before the
    // rename to avoid platform rename-onto-dir quirks. Kept inside the try so a
    // rename failure surfaces the same actionable error as a write failure.
    rmSync(destDir, { recursive: true, force: true });
    renameSync(tempDir, destDir);
  } catch (e) {
    throw new Error(`${e.message} (export left at ${tempDir}; remove it manually)`, { cause: e });
  }
}

export async function main(argv, { fetchImpl } = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    // node:util parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code for
    // unknown flags and flags missing their value: a usage error, not exit 1.
    if (!e?.code?.startsWith('ERR_PARSE_ARGS_')) throw e;
    return bail(`${e.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stderr.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const usingShs = values['shs-base-url'] !== undefined;
  if (usingShs) {
    if (positionals.length > 0) {
      return bail(`Pass either <event-log-file|rolling-log-dir> or --shs-base-url, not both.\n${USAGE}`, 2);
    }
    if (values['app-id'] === undefined) {
      return bail(`--shs-base-url requires --app-id.\n${USAGE}`, 2);
    }
  } else {
    if (positionals.length !== 1) {
      return bail(USAGE, 2);
    }
    if (values['app-id'] !== undefined || values['attempt-id'] !== undefined) {
      return bail(`--app-id/--attempt-id require --shs-base-url.\n${USAGE}`, 2);
    }
  }

  if (values.format !== undefined && values.format !== 'json' && values.format !== 'md') {
    return bail(`Invalid value for --format (expected "json" or "md").\n${USAGE}`, 2);
  }

  let exportHtmlDir;
  if (values['export-html'] !== undefined) {
    exportHtmlDir = resolve(values['export-html']);
    // readdirSync throws ENOTDIR when the path exists but is a regular file
    // (e.g. a report path accidentally reused as the export target): catch
    // that here so it becomes a clean bail() instead of an uncaught crash.
    let existingContents;
    try {
      existingContents = existsSync(exportHtmlDir) ? readdirSync(exportHtmlDir) : [];
    } catch (e) {
      return bail(`--export-html: ${exportHtmlDir} exists but is not a directory (${e.message}).\n${USAGE}`, 2);
    }
    if (existingContents.length > 0) {
      return bail(`--export-html: ${exportHtmlDir} already exists and is not empty.\n${USAGE}`, 2);
    }
  }

  const usingBaseline = values.baseline !== undefined;
  // Single source of truth for which flags need --baseline: append a future
  // flag here rather than adding its own OR-condition (easy to forget).
  const BASELINE_DEPENDENT_FLAGS = ['max-regression-pct', 'regression-metric', 'fail-on-introduced'];
  if (!usingBaseline && BASELINE_DEPENDENT_FLAGS.some((flag) => values[flag] !== undefined)) {
    return bail(`--max-regression-pct/--regression-metric/--fail-on-introduced require --baseline.\n${USAGE}`, 2);
  }
  if (values['regression-metric'] !== undefined && values['max-regression-pct'] === undefined) {
    return bail(`--regression-metric requires --max-regression-pct.\n${USAGE}`, 2);
  }
  if (values['regression-metric'] !== undefined && !COMPARISON_METRIC_KEYS.includes(values['regression-metric'])) {
    return bail(`Unknown --regression-metric "${values['regression-metric']}" (expected one of: ${COMPARISON_METRIC_KEYS.join(', ')}).\n${USAGE}`, 2);
  }

  const budgets = {
    maxRuntimeMs: values['max-runtime'] != null ? Number(values['max-runtime']) : undefined,
    maxSpillGb: values['max-spill'] != null ? Number(values['max-spill']) : undefined,
    maxSkewRatio: values['max-skew'] != null ? Number(values['max-skew']) : undefined,
    maxFailedTaskRatePct: values['max-failed-task-rate'] != null ? Number(values['max-failed-task-rate']) : undefined,
    minEfficiencyPct: values['min-efficiency'] != null ? Number(values['min-efficiency']) : undefined,
    maxRegressionPct: values['max-regression-pct'] != null ? Number(values['max-regression-pct']) : undefined,
  };
  // Derived from `budgets`, not hardcoded: every key above is numeric
  // (regressionMetric/failOnIntroduced are added below), so a future numeric
  // budget field can't skip this check.
  const NUMERIC_BUDGET_FLAGS = Object.keys(budgets);
  for (const flag of NUMERIC_BUDGET_FLAGS) {
    const value = budgets[flag];
    if (value !== undefined && !Number.isFinite(value)) {
      return bail(`Invalid numeric value for ${flag}.\n${USAGE}`, 2);
    }
  }
  // Only set when the user passed --regression-metric: evaluateBudgets() treats
  // "regressionMetric is set" as "caller asked for a regression check", so
  // defaulting it here would trip that guard on runs that touched neither flag.
  // checkRegression falls back to 'wallClock' itself once maxRegressionPct is set.
  if (values['regression-metric'] !== undefined) budgets.regressionMetric = values['regression-metric'];
  if (values['fail-on-introduced'] !== undefined) budgets.failOnIntroduced = values['fail-on-introduced'];

  const impactBand = splitCsv(values.impact);
  const type = splitCsv(values.type);
  let stageId;
  if (values.stage !== undefined) {
    stageId = Number(values.stage);
    if (!Number.isInteger(stageId)) {
      return bail(`Invalid integer value for --stage.\n${USAGE}`, 2);
    }
  }
  const findingsFilter = toFindingsFilter(impactBand, type, stageId);

  let appModel;
  let baselineAppModel;
  // Assigned by every branch below before it's read.
  let skippedLines;
  try {
    if (usingShs) {
      const shsPromise = resolveFromShs(
        values['shs-base-url'], values['app-id'], values['attempt-id'],
        fetchImpl !== undefined ? { fetchImpl } : {},
      );
      // SHS fetch (network) and local --baseline parse (disk) are independent,
      // so run them concurrently. Not done for local+local below: both are CPU
      // work, so parallelizing wouldn't help.
      if (usingBaseline) {
        const [shsResult, baselineResult] = await Promise.all([shsPromise, collectWithEvidence(values.baseline)]);
        ({ appModel, skippedLines } = shsResult);
        baselineAppModel = baselineResult.appModel;
      } else {
        ({ appModel, skippedLines } = await shsPromise);
      }
    } else {
      ({ appModel, skippedLines } = await collectWithEvidence(positionals[0]));
      if (usingBaseline) {
        const baselineResult = await collectWithEvidence(values.baseline);
        baselineAppModel = baselineResult.appModel;
      }
    }
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 2;
    return;
  }

  const analyzeModel = (model) => analyze(
    model.app, model.stages, model.executors.added, model.executors.removed,
    model.jobs, model.sql, model.runAggregates,
  );
  const catalog = analyzeModel(appModel);

  if (exportHtmlDir !== undefined) {
    try {
      await writeHtmlExport(exportHtmlDir, appModel, catalog, skippedLines, { redact: values.redact });
    } catch (e) {
      process.stderr.write(`--export-html failed: ${e.message}\n`);
      process.exitCode = 2;
      return;
    }
  }

  let comparison;
  if (usingBaseline) {
    const baselineCatalog = analyzeModel(baselineAppModel);
    comparison = buildComparison(
      { label: 'baseline', appModel: baselineAppModel, catalog: baselineCatalog },
      { label: 'candidate', appModel, catalog },
    );
    // --redact must also scrub the comparison section: stage names there carry
    // raw Spark stage text, which --redact promises to pseudonymize.
    if (values.redact) comparison = redactComparison(comparison);
  }

  const { markdown, json } = buildEvidenceReport(appModel, { redact: values.redact, findingsFilter, markdown: values.format === 'md' });
  let output;
  if (values.format === 'md') {
    output = comparison ? `${markdown}${renderComparisonMarkdown(comparison)}\n` : `${markdown}\n`;
  } else {
    const payload = comparison
      ? {
        candidate: json,
        comparison: {
          confidence: comparison.confidence,
          reason: comparison.reason,
          matchedCoverage: comparison.matchedCoverage,
          metrics: comparison.metrics,
          findings: comparison.findings,
        },
      }
      : json;
    output = `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);

  const { results, violated, inconclusive } = evaluateBudgets({ appModel, catalog, budgets, comparison });
  for (const r of results) {
    if (r.status === 'inconclusive') process.stderr.write(`[inconclusive] ${r.name}: ${r.detail}\n`);
    else if (r.status === 'violation') process.stderr.write(`[violation] ${r.name}: ${r.detail}\n`);
  }

  if (violated) process.exitCode = 1;
  else if (inconclusive) process.exitCode = 3;
  else process.exitCode = 0;
}

// Guarded so tests can import `main` without triggering a real invocation.
// A published install's bin is a node_modules/.bin/ symlink, so argv[1] must be
// realpath-resolved first; otherwise the guard never matches through the symlink
// and the CLI silently does nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
