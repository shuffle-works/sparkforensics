#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  readFileSync, writeFileSync, existsSync, realpathSync,
  mkdtempSync, mkdirSync, rmSync, renameSync, readdirSync, cpSync, appendFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(binDir);

// vendor-core/ is populated by vendor-core.mjs at pack time. In the monorepo the
// packages/core/src/ sibling's load-vendored.js is used, which prefers a leftover
// vendor-core/ only while it still matches core/src and warns when it does not.
// load-vendored.js is the one module located by hand; the rest load through its
// exported loadVendored().
const srcHelper = join(pkgDir, '..', 'core', 'src', 'load-vendored.js');
const helperPath = existsSync(srcHelper) ? srcHelper : join(pkgDir, 'vendor-core', 'load-vendored.js');
const { coreBuildId, loadVendored } = await import(pathToFileURL(helperPath).href);
const loadCore = (moduleName, opts) => loadVendored(pkgDir, moduleName, opts);

const { collectRun } = await loadCore('cli/collect-run');
const { resolveFromShs } = await loadCore('shs-load');
const { validateShsRequest } = await loadCore('shs-request', { srcExt: 'js' });
const { analyze, auditConfig } = await loadCore('analyzer');
const { deriveEvidenceAvailability } = await loadCore('evidence-availability');
const { buildEvidenceReport, toFindingsFilter } = await loadCore('evidence-report');
const { evaluateBudgets } = await loadCore('cli/budgets');
const { buildComparison, renderComparisonMarkdown, COMPARISON_METRIC_KEYS } = await loadCore('run-comparison');
const { comparisonVerdict } = await loadCore('comparison-verdict');
const { redactComparison, redactRunModel } = await loadCore('redact');
const { buildHtmlExportData, encodeRunPayload } = await loadCore('html-export');
const { runPayloadScript } = await loadCore('run-payload');
const { loadThresholdOverrides } = await loadCore('cli/threshold-config');
const { parseRegressionBudgetFlag, loadBudgetsFile, combineRegressionBudgets } = await loadCore('cli/regression-budgets');
const { tunedDetectors } = await loadCore('threshold-overrides');
const { computeRunMetrics } = await loadCore('run-metrics');
const { buildEffectiveConf } = await loadCore('effective-conf');

const USAGE = `Usage: sparkforensics-analyze <event-log-file|rolling-log-dir> [options]
       sparkforensics-analyze <event-log-file|rolling-log-dir>... --baseline <path> [options]
       sparkforensics-analyze --shs-base-url <url> --app-id <id> [--attempt-id <id>] [options]

Options:
  --format md|json|ndjson          Output format (default: json; ndjson with two or more candidate
                                    logs). ndjson requires --baseline, see "Several candidates".
  --out <path>                    Write output to a file instead of stdout.
  --export-html <dir>              Write a self-contained HTML dashboard for this run into <dir>
                                    (must not exist or be empty). Open <dir>/index.html directly, no
                                    server required. Can be combined with --format/--out, which write
                                    their own separate output unchanged.
  --max-runtime <ms>               Fail if app runtime exceeds this many ms.
  --max-spill <gb>                  Fail if any stage spills more than this many GB.
  --max-skew <ratio>                Fail if any stage's P95/median duration ratio exceeds this.
  --max-failed-task-rate <pct>      Fail if the task failure rate exceeds this percent.
  --min-efficiency <pct>            Fail if busy core time (the share of executor core time
                                    that ran tasks, 100 minus the dashboard's Unused core time)
                                    falls below this percent. Not the dashboard's Efficiency tile.
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
  --regression-budget <metric>:<pct>
                                    Requires --baseline. Fail if <metric> regressed by more than
                                    <pct> percent. Repeat the flag for several metrics. A metric can
                                    be budgeted once across this flag, --budgets and the
                                    --max-regression-pct/--regression-metric pair (which counts as
                                    one more budget).
  --budgets <file>                  Requires --baseline. JSON file {"regression": {"<metric>": <pct>}}
                                    with the same budgets as --regression-budget. Unknown keys and
                                    metrics, and a percentage that is not a non-negative number, are
                                    rejected.
  --fail-on-introduced <band|all>   Requires --baseline. Fail if any finding was introduced by
                                    the candidate matching this impact band (or any, with "all").
  --redact                          Pseudonymize the app id and any host/IP tokens in the output
                                    (app-1, host-1, ...), so a report can be shared outside the
                                    environment that produced it.
  --impact <band[,band]>            Filter the output's findings array to these impact bands
                                    (critical, warning, info). recommendations, cleanChecks,
                                    notRunChecks and the summary counts stay on the full,
                                    unfiltered set.
  --type <type[,type]>              Filter the output's findings array to these finding types.
  --stage <id>                      Filter the output's findings array to this stage id,
                                    including a SQL plan finding whose only stage it is.
  --thresholds <file>               Run the detectors with the threshold overrides in this JSON
                                    file ({"<detector>": {"<threshold>": value}}; names, units and
                                    defaults are in the report's detectors catalog). Findings a
                                    tuned detector produces are marked and their impact estimates
                                    flagged as uncalibrated. Applies to --baseline too; the
                                    --export-html dashboard keeps the default thresholds.
  --conf-keys <key[,key]>           Narrow the JSON output's effectiveConf to these Spark
                                    properties. Keys the log does not contain are listed as absent.
  --conf-redact-regex <pattern>     Also withhold the value of any Spark property whose key or
                                    value matches this pattern, on top of Spark's default secret
                                    pattern and the job's own spark.redaction.regex.

Several candidates: pass two or more logs as positional arguments, with --baseline, to compare
each against the baseline, which is parsed once. Output is NDJSON, one line per candidate in
argument order: {"log", "status", "exitCode", "error", "budgets", "candidate", "comparison"}.
status is pass, violation, inconclusive or error. A candidate that cannot be read or parsed gets
an "error" line (exitCode 4, candidate and comparison null); the rest still run. An internal
failure while analyzing one candidate gets an "error" line with exitCode 6. With --redact, "log"
and the stderr prefixes name a candidate by position (candidate-1, candidate-2, ...) and an error
line carries a generic message, so no candidate path is written. Not combinable with
--export-html, --shs-base-url or --format json|md. The exit code is the worst line, in the order
6, 5, 4, 1, 3, 0; a usage error exits 2 before any candidate runs.

Exit codes: 0 pass, 1 a budget was violated, 2 usage error (bad flags or arguments, an unreadable
or invalid --thresholds or --budgets file), 3 a budget was inconclusive, 4 the candidate log could
not be read or parsed (or the --shs-base-url fetch failed), 5 the --baseline log could not be read
or parsed (no candidate lines are written), 6 internal error (including a failed --export-html).
With --redact, a log that cannot be read, parsed or analyzed is reported by its role (the baseline,
the candidate, or candidate N with several candidates) instead of the error text, which may carry
its path.
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
      'regression-budget': { type: 'string', multiple: true },
      budgets: { type: 'string' },
      'fail-on-introduced': { type: 'string' },
      redact: { type: 'boolean' },
      'export-html': { type: 'string' },
      impact: { type: 'string' },
      type: { type: 'string' },
      stage: { type: 'string' },
      thresholds: { type: 'string' },
      'conf-keys': { type: 'string' },
      'conf-redact-regex': { type: 'string' },
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

function analyzeModel(model, options) {
  return analyze(
    model.app, model.stages, model.executors.added, model.executors.removed,
    model.jobs, model.sql, model.runAggregates, options,
  );
}

// The export's provenance stamp: this CLI's own name and version, and the build id of the core it
// loaded (vendor-core/'s stamp or core/src's hash, see coreBuildId).
function exportProducer() {
  const { name, version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  return `${name} ${version}`;
}

async function writeHtmlExport(destDir, appModel, catalog, skippedLines, { redact }) {
  const exportData = buildHtmlExportData(appModel, catalog, skippedLines, {
    redact, buildId: coreBuildId(pkgDir), producer: exportProducer(),
  });

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
    // The dashboard download's encoding too (gzip + base64); decodeRunPayload
    // (hydrate-store.ts) reverses it. runPayloadScript explains why base64
    // needs no escaping.
    writeFileSync(join(tempDir, 'data.js'), `${runPayloadScript(encodeRunPayload(exportData))}\n`);
    // Clear destDir (confirmed empty-or-absent by the caller) right before the
    // rename to avoid platform rename-onto-dir quirks. Kept inside the try so a
    // rename failure surfaces the same actionable error as a write failure.
    rmSync(destDir, { recursive: true, force: true });
    renameSync(tempDir, destDir);
  } catch (e) {
    throw new Error(`${e.message} (export left at ${tempDir}; remove it manually)`, { cause: e });
  }
}

const SHS_FLAG_BY_FIELD = { baseUrl: '--shs-base-url', appId: '--app-id', attemptId: '--attempt-id' };

const EXIT = { PASS: 0, VIOLATION: 1, USAGE: 2, INCONCLUSIVE: 3, CANDIDATE_UNREADABLE: 4, BASELINE_UNREADABLE: 5, INTERNAL: 6 };

// Worst-wins order of the exit codes several candidates can produce, least to most severe:
// 0, 3, 1, 4, 5, 6. (2 is a usage error and exits before any candidate runs.)
const EXIT_SEVERITY = Object.fromEntries([0, 3, 1, 4, 5, 6].map((code, rank) => [code, rank]));

// Marks a read/parse failure with the exit code of the log it came from.
const unreadable = (promise, exitCode) => promise.catch((e) => { e.exitCode = exitCode; throw e; });

// The --redact stand-in for a log failure's own message, which may carry the log path (and so the app id).
const redactedFailure = (role, exitCode) => `${role} could not be ${exitCode === EXIT.INTERNAL ? 'analyzed' : 'read or parsed'}.`;

// One baseline against several candidates, one NDJSON line each. The baseline is parsed and
// analyzed once; candidates run one at a time so only one parsed log is held at once. A candidate
// that cannot be read or parsed yields an "error" line (exit code 4) and the rest still run. Under --redact
// a candidate is named by its position (candidate-1, ...): log file names usually carry the app id.
async function runMultiLog({ candidatePaths, baselinePath, budgets, thresholds, findingsFilter, redact, outPath }) {
  let baselineAppModel;
  try {
    ({ appModel: baselineAppModel } = await collectWithEvidence(baselinePath));
  } catch (e) {
    process.stderr.write(`${redact ? redactedFailure('The baseline', EXIT.BASELINE_UNREADABLE) : e.message}\n`);
    process.exitCode = EXIT.BASELINE_UNREADABLE;
    return;
  }
  const baselineCatalog = analyzeModel(baselineAppModel, { thresholds });
  if (outPath) writeFileSync(outPath, '');
  const emit = (line) => {
    const text = `${JSON.stringify(line)}\n`;
    if (outPath) appendFileSync(outPath, text);
    else process.stdout.write(text);
  };

  let worstExit = 0;
  for (const [index, path] of candidatePaths.entries()) {
    const log = redact ? `candidate-${index + 1}` : path;
    let line;
    try {
      const { appModel } = await unreadable(collectWithEvidence(path), EXIT.CANDIDATE_UNREADABLE);
      const catalog = analyzeModel(appModel, { thresholds });
      let comparison = buildComparison(
        { label: 'baseline', appModel: baselineAppModel, catalog: baselineCatalog },
        { label: 'candidate', appModel, catalog },
      );
      if (redact) comparison = redactComparison(comparison);
      const { json } = buildEvidenceReport(appModel, { redact, findingsFilter, markdown: false, thresholds });
      const { results, violated, inconclusive } = evaluateBudgets({ appModel, catalog, budgets, comparison, thresholds });
      for (const r of results) {
        if (r.status !== 'pass') process.stderr.write(`${log}: [${r.status === 'violation' ? 'violation' : 'inconclusive'}] ${r.name}: ${r.detail}\n`);
      }
      const exitCode = violated ? EXIT.VIOLATION : inconclusive ? EXIT.INCONCLUSIVE : EXIT.PASS;
      line = {
        log,
        status: violated ? 'violation' : inconclusive ? 'inconclusive' : 'pass',
        exitCode,
        error: null,
        budgets: results,
        candidate: json,
        comparison: {
          verdict: comparisonVerdict(comparison),
          confidence: comparison.confidence,
          reason: comparison.reason,
          matchedCoverage: comparison.matchedCoverage,
          metrics: comparison.metrics,
          findings: comparison.findings,
        },
      };
    } catch (e) {
      const exitCode = e.exitCode ?? EXIT.INTERNAL;
      const error = redact ? redactedFailure(`Candidate ${index + 1}`, exitCode) : e.message;
      process.stderr.write(`${log}: [error] ${error}\n`);
      line = { log, status: 'error', exitCode, error, budgets: [], candidate: null, comparison: null };
    }
    emit(line);
    if (EXIT_SEVERITY[line.exitCode] > EXIT_SEVERITY[worstExit]) worstExit = line.exitCode;
  }
  process.exitCode = worstExit;
}

// Any failure not handled below (a bug, an unwritable --out) exits 6 instead of crashing with
// Node's own exit code, which would read as a violation.
export async function main(argv, options) {
  try {
    await runCli(argv, options);
  } catch (e) {
    process.stderr.write(`Internal error: ${e?.stack ?? e}\n`);
    process.exitCode = EXIT.INTERNAL;
  }
}

async function runCli(argv, { fetchImpl } = {}) {
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
    const { errors } = validateShsRequest({
      baseUrl: values['shs-base-url'], appId: values['app-id'], attemptId: values['attempt-id'],
    });
    const invalid = Object.entries(errors).filter(([, message]) => message);
    if (invalid.length > 0) {
      return bail(`${invalid.map(([field, message]) => `Invalid ${SHS_FLAG_BY_FIELD[field]}: ${message}`).join('\n')}\n${USAGE}`, 2);
    }
  } else {
    if (positionals.length === 0 || (positionals.length > 1 && values.baseline === undefined)) {
      return bail(USAGE, 2);
    }
    if (values['app-id'] !== undefined || values['attempt-id'] !== undefined) {
      return bail(`--app-id/--attempt-id require --shs-base-url.\n${USAGE}`, 2);
    }
  }

  if (values.format !== undefined && !['json', 'md', 'ndjson'].includes(values.format)) {
    return bail(`Invalid value for --format (expected "json", "md" or "ndjson").\n${USAGE}`, 2);
  }
  // Two or more candidates, or an explicit ndjson, run the multi-candidate mode.
  const multiLog = !usingShs && (positionals.length > 1 || values.format === 'ndjson');
  if (multiLog) {
    if (values.baseline === undefined) return bail(`--format ndjson requires --baseline.\n${USAGE}`, 2);
    if (values.format !== undefined && values.format !== 'ndjson') {
      return bail(`Several candidate logs write NDJSON; --format ${values.format} cannot be combined with them.\n${USAGE}`, 2);
    }
    if (values['export-html'] !== undefined) {
      return bail(`--export-html writes one dashboard and cannot be combined with several candidate logs.\n${USAGE}`, 2);
    }
  } else if (values.format === 'ndjson') {
    return bail(`--format ndjson requires --baseline and a local candidate log.\n${USAGE}`, 2);
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
  const BASELINE_DEPENDENT_FLAGS = ['max-regression-pct', 'regression-metric', 'fail-on-introduced', 'regression-budget', 'budgets'];
  if (!usingBaseline && BASELINE_DEPENDENT_FLAGS.some((flag) => values[flag] !== undefined)) {
    return bail(`--max-regression-pct/--regression-metric/--regression-budget/--budgets/--fail-on-introduced require --baseline.\n${USAGE}`, 2);
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

  // --regression-budget and --budgets add to the legacy pair; a metric budgeted twice is refused.
  if (values['regression-budget'] !== undefined || values.budgets !== undefined) {
    try {
      const extra = (values['regression-budget'] ?? []).map((spec) => (
        { origin: '--regression-budget', budget: parseRegressionBudgetFlag(spec) }));
      if (values.budgets !== undefined) {
        for (const budget of loadBudgetsFile(values.budgets)) extra.push({ origin: '--budgets', budget });
      }
      const legacy = budgets.maxRegressionPct === undefined ? [] : [{
        origin: '--max-regression-pct/--regression-metric',
        budget: { metric: budgets.regressionMetric ?? 'wallClock', maxPct: budgets.maxRegressionPct },
      }];
      combineRegressionBudgets([...legacy, ...extra]);
      budgets.regressionBudgets = extra.map((e) => e.budget);
    } catch (e) {
      return bail(`${e.message}\n${USAGE}`, 2);
    }
  }

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

  // Read before any log is parsed: a bad file refuses the run rather than falling back to defaults.
  let thresholds;
  if (values.thresholds !== undefined) {
    try {
      thresholds = loadThresholdOverrides(values.thresholds);
    } catch (e) {
      return bail(`--thresholds: ${e.message}\n`, 2);
    }
  }

  const confKeys = splitCsv(values['conf-keys']);
  if (confKeys !== undefined && confKeys.length === 0) {
    return bail(`--conf-keys needs at least one property name.\n${USAGE}`, 2);
  }
  // Compiled before any log is parsed so a bad pattern is a usage error, not a late crash.
  if (values['conf-redact-regex'] !== undefined) {
    try {
      buildEffectiveConf({ config: {} }, { userPattern: values['conf-redact-regex'] });
    } catch (e) {
      return bail(`--conf-redact-regex: ${e.message}\n`, 2);
    }
  }

  if (multiLog) {
    return runMultiLog({
      candidatePaths: positionals, baselinePath: values.baseline, budgets, thresholds,
      findingsFilter, redact: values.redact, outPath: values.out,
    });
  }

  let appModel;
  let baselineAppModel;
  // Assigned by every branch below before it's read.
  let skippedLines;
  try {
    if (usingShs) {
      const shsPromise = unreadable(resolveFromShs(
        values['shs-base-url'], values['app-id'], values['attempt-id'],
        fetchImpl !== undefined ? { fetchImpl } : {},
      ), EXIT.CANDIDATE_UNREADABLE);
      // SHS fetch (network) and local --baseline parse (disk) are independent,
      // so run them concurrently. Not done for local+local below: both are CPU
      // work, so parallelizing wouldn't help.
      if (usingBaseline) {
        const [shsResult, baselineResult] = await Promise.allSettled([
          shsPromise, unreadable(collectWithEvidence(values.baseline), EXIT.BASELINE_UNREADABLE),
        ]);
        // The baseline's failure wins, as it does for local logs (exit 5 outranks 4).
        if (baselineResult.status === 'rejected') throw baselineResult.reason;
        if (shsResult.status === 'rejected') throw shsResult.reason;
        ({ appModel, skippedLines } = shsResult.value);
        baselineAppModel = baselineResult.value.appModel;
      } else {
        ({ appModel, skippedLines } = await shsPromise);
      }
    } else {
      // Baseline first, so a batch with both logs unreadable reports the worse exit code (5).
      if (usingBaseline) {
        const baselineResult = await unreadable(collectWithEvidence(values.baseline), EXIT.BASELINE_UNREADABLE);
        baselineAppModel = baselineResult.appModel;
      }
      ({ appModel, skippedLines } = await unreadable(collectWithEvidence(positionals[0]), EXIT.CANDIDATE_UNREADABLE));
    }
  } catch (e) {
    const exitCode = e.exitCode ?? EXIT.INTERNAL;
    const role = exitCode === EXIT.BASELINE_UNREADABLE ? 'The baseline' : 'The candidate';
    process.stderr.write(`${values.redact ? redactedFailure(role, exitCode) : e.message}\n`);
    process.exitCode = exitCode;
    return;
  }

  const catalog = analyzeModel(appModel, { thresholds });

  if (exportHtmlDir !== undefined) {
    // The dashboard never tunes, so the export is the default-threshold analysis of the run.
    const tuned = tunedDetectors(thresholds) !== null;
    if (tuned) {
      process.stderr.write('--export-html: the exported dashboard uses the default detector thresholds; --thresholds applies to the report only.\n');
    }
    try {
      await writeHtmlExport(exportHtmlDir, appModel, tuned ? analyzeModel(appModel) : catalog, skippedLines, { redact: values.redact });
    } catch (e) {
      process.stderr.write(`--export-html failed: ${e.message}\n`);
      process.exitCode = EXIT.INTERNAL;
      return;
    }
  }

  let comparison;
  if (usingBaseline) {
    const baselineCatalog = analyzeModel(baselineAppModel, { thresholds });
    comparison = buildComparison(
      { label: 'baseline', appModel: baselineAppModel, catalog: baselineCatalog },
      { label: 'candidate', appModel, catalog },
    );
    // --redact must also scrub the comparison section: stage names there carry
    // raw Spark stage text, which --redact promises to pseudonymize.
    if (values.redact) comparison = redactComparison(comparison);
  }

  const { markdown, json } = buildEvidenceReport(appModel, {
    redact: values.redact, findingsFilter, markdown: values.format === 'md', thresholds,
  });
  let output;
  if (values.format === 'md') {
    output = comparison ? `${markdown}${renderComparisonMarkdown(comparison, comparisonVerdict(comparison))}\n` : `${markdown}\n`;
  } else {
    // Additive blocks on the report: each carries its own schemaVersion. Under --redact they come
    // from the run redacted with the report's own inputs, so host and app pseudonyms in stage
    // fingerprints and conf values match the report's.
    const blocksModel = values.redact ? redactRunModel(appModel, catalog, auditConfig(appModel.app)).appModel : appModel;
    const machineReadable = {
      metrics: computeRunMetrics(blocksModel, thresholds),
      effectiveConf: buildEffectiveConf(blocksModel.app, { keys: confKeys, userPattern: values['conf-redact-regex'] }),
    };
    const payload = comparison
      ? {
        candidate: { ...json, ...machineReadable },
        comparison: {
          verdict: comparisonVerdict(comparison),
          confidence: comparison.confidence,
          reason: comparison.reason,
          matchedCoverage: comparison.matchedCoverage,
          metrics: comparison.metrics,
          findings: comparison.findings,
        },
      }
      : { ...json, ...machineReadable };
    output = `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (values.out) writeFileSync(values.out, output);
  else process.stdout.write(output);

  const { results, violated, inconclusive } = evaluateBudgets({ appModel, catalog, budgets, comparison, thresholds });
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
