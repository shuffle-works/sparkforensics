#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  readFileSync, writeFileSync, existsSync, realpathSync,
  mkdtempSync, mkdirSync, rmSync, renameSync, readdirSync, cpSync, appendFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import nodeModule from 'node:module';

// Reuse V8's compiled code for the ~100 core modules across runs (Node 22.1+; a no-op on older
// Node, and by NODE_DISABLE_COMPILE_CACHE). It only covers modules loaded after this call.
nodeModule.enableCompileCache?.();

const binDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(binDir);

// Core loading (vendor-core/ vs core/src): docs-site/contributor-guide/development-setup.md, "Generated and vendored files".
const srcHelper = join(pkgDir, '..', 'core', 'src', 'load-vendored.js');
const helperPath = existsSync(srcHelper) ? srcHelper : join(pkgDir, 'vendor-core', 'load-vendored.js');
const { coreBuildId, loadVendored } = await import(pathToFileURL(helperPath).href);
const loadCore = (moduleName, opts) => loadVendored(pkgDir, moduleName, opts);

const { collectRun } = await loadCore('cli/collect-run');
const { collectRunPair } = await loadCore('cli/collect-run-pair');
const { resolveFromShs } = await loadCore('shs-load');
const { validateShsRequest } = await loadCore('shs-request', { srcExt: 'js' });
const { deriveEvidenceAvailability } = await loadCore('evidence-availability');
const { buildEvidenceReport, runFindings, toFindingsFilter } = await loadCore('evidence-report');
const { evaluateBudgets } = await loadCore('cli/budgets');
const { renderComparisonMarkdown, COMPARISON_METRIC_KEYS } = await loadCore('run-comparison');
const { buildComparisonOutput } = await loadCore('comparison-output');
const { compileNormalizePatterns, MAX_NORMALIZE_PATTERN_LENGTH, MAX_NORMALIZE_PATTERNS } = await loadCore('stage-alignment');
const { compileConfIgnorePatterns } = await loadCore('comparability');
const { DEFAULT_NOISE_BAND } = await loadCore('run-comparison');
const { buildHtmlExportData, encodeRunPayload } = await loadCore('html-export');
const { runPayloadScript } = await loadCore('run-payload');
const { loadThresholdOverrides } = await loadCore('cli/threshold-config');
const { parseRegressionBudgetFlag, loadBudgetsFile, combineRegressionBudgets, parseStageRegressionBudgetFlag, parseStageQualities } = await loadCore('cli/regression-budgets');
const { parseNonNegativeNumber, parseStageId, parseImpactBands, parseFindingTypes, parseFailOnIntroduced } = await loadCore('cli/flag-values');
const { tunedDetectors } = await loadCore('threshold-overrides');
const { runOutputBlocks } = await loadCore('run-output');
const { buildEffectiveConf } = await loadCore('effective-conf');

const USAGE = `Usage: sparkforensics-analyze <event-log-file|rolling-log-dir> [options]
       sparkforensics-analyze <event-log-file|rolling-log-dir>... --baseline <path> [options]
       sparkforensics-analyze --shs-base-url <url> --app-id <id> [--attempt-id <id>] [options]
       sparkforensics-analyze --shs-base-url <url> --app-id <id>[:<attempt>] --app-id <id>[:<attempt>]...
                              (--baseline <path> | --baseline-shs-base-url <url> --baseline-app-id <id>) [options]

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
                                    The six budget flags above and --max-regression-pct take a plain
                                    non-negative decimal such as 90 or 1.5; an empty, negative,
                                    hexadecimal or exponent value is a usage error.
  --shs-base-url <url>              Fetch the run from a Spark History Server instead of a
                                    local file (mutually exclusive with the positional argument).
  --app-id <id>                     Spark application ID to fetch. Required with --shs-base-url.
                                    Repeat it for several candidates from the same server, see
                                    "Several candidates". <id>:<attempt> names an attempt.
  --attempt-id <id>                 Optional attempt ID, used with --shs-base-url and a single
                                    --app-id.
  --baseline <path>                 Compare the run against a baseline local event-log file or
                                    rolling-log directory. Adds a comparison section to the output.
                                    Mutually exclusive with --baseline-shs-base-url.
  --baseline-shs-base-url <url>     Fetch the baseline from a Spark History Server instead of a
                                    local path. It can be a different server than --shs-base-url.
  --baseline-app-id <id>            Baseline application ID. Required with --baseline-shs-base-url.
  --baseline-attempt-id <id>        Optional baseline attempt ID, used with --baseline-shs-base-url.
  --max-regression-pct <pct>        Requires a baseline. Fail if the regression metric (see
                                    --regression-metric) regressed by more than this percent.
  --regression-metric <key>         Metric key to check with --max-regression-pct (default:
                                    wallClock). Requires a baseline and --max-regression-pct.
  --regression-budget <metric>:<pct>
                                    Requires a baseline. Fail if <metric> regressed by more than
                                    <pct> percent. Repeat the flag for several metrics. A metric can
                                    be budgeted once across this flag, --budgets and the
                                    --max-regression-pct/--regression-metric pair (which counts as
                                    one more budget).
  --budgets <file>                  Requires a baseline. JSON file {"regression": {"<metric>": <pct>}}
                                    with the same budgets as --regression-budget. Unknown keys and
                                    metrics, and a percentage that is not a non-negative number, are
                                    rejected.
  --stage-regression-budget <metric>:<pct>
                                    Requires a baseline. Fail if any paired stage's <metric>
                                    (executorRunTime, executorCpuTime, memoryBytesSpilled,
                                    diskBytesSpilled, shuffleReadBytes, shuffleWriteBytes) grew
                                    by more than <pct> percent against its baseline stage.
                                    Repeat the flag for several metrics. inputBytes and outputBytes
                                    are refused (usage error): volume has no regression direction.
                                    Inconclusive (exit 3) when no stage pairs or the metric is missing.
  --stage-quality <q[,q]>           Requires --stage-regression-budget. Pair qualities the stage
                                    budgets read, from exact, structural, aligned (default:
                                    exact,structural; an aligned pair may compare different work).
  --fail-on-introduced <band|all>   Requires a baseline. Fail if any finding was introduced by
                                    the candidate matching this impact band (or any, with "all").
                                    A finding the baseline also has at the same place is not
                                    introduced, unless its band worsens to exactly this band.
  --redact                          Pseudonymize the app id, the app name and every host name and
                                    IP address in the output (app-1, host-1, ...), including the
                                    host of any URL. A user name in URL credentials, after /user/,
                                    /home/ or /Users/, or in a user= value becomes redacted-user.
                                    Other paths, table names and SQL text are kept as written, so
                                    check the output before sharing it outside the environment
                                    that produced it.
  --impact <band[,band]>            Filter the output's findings array to these impact bands
                                    (critical, warning, info). recommendations, cleanChecks,
                                    notRunChecks and the summary counts stay on the full,
                                    unfiltered set.
  --type <type[,type]>              Filter the output's findings array to these finding types. An
                                    unknown band or type is a usage error.
  --stage <id>                      Filter the output's findings array to this stage id (a
                                    non-negative integer),
                                    including a SQL plan finding whose only stage it is.
  --normalize-path <regex>          Requires a baseline. Repeatable. A regular expression whose every
                                    match in a plan node's text is replaced with a fixed token before
                                    stages are paired between the runs, so run-specific text, such as
                                    an output directory that differs per run, does not keep the same
                                    stage from pairing. Despite the name it is a generic pattern, not
                                    only for paths. It affects stage pairing and the runtime coverage
                                    and confidence derived from it, never the findings. Up to
                                    ${MAX_NORMALIZE_PATTERNS} patterns of ${MAX_NORMALIZE_PATTERN_LENGTH} characters; a pattern
                                    that matches the empty string is refused.
  --ignore-conf <regex>             Requires a baseline. Repeatable. A regular expression matched
                                    against Spark configuration keys: a key that matches is left out
                                    of the comparison's configuration check, for keys that differ by
                                    design, such as a per-run output path. Per-run identity keys
                                    (application id, start time, driver address) are always left out.
                                    Same limits as --normalize-path.
  --noise-band-pct <pct>            Requires a baseline. A metric that differs from the baseline by
                                    less than this percentage is marked withinNoise (default 2). It
                                    never changes a metric's direction.
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

Several candidates: pass two or more logs as positional arguments, or two or more --app-id values
with one --shs-base-url, with a baseline (--baseline or --baseline-shs-base-url), to compare each
against the baseline, which is parsed once. Output is NDJSON, one line per candidate in
argument order: {"log", "status", "exitCode", "error", "budgets", "candidate", "comparison"}.
status is pass, violation, inconclusive or error. A candidate that cannot be read or parsed gets
an "error" line (exitCode 4, candidate and comparison null); the rest still run. An internal
failure while analyzing one candidate gets an "error" line with exitCode 6. With --redact, "log"
and the stderr prefixes name a candidate by position (candidate-1, candidate-2, ...) and an error
line carries a generic message, so no candidate path or application ID is written. "log" is the
path, or the --app-id value as given. Not combinable with --export-html, --format json|md, or a mix
of positional logs and --shs-base-url. --format ndjson with a single --app-id is not supported. The exit code is the worst line, in the order
6, 5, 4, 1, 3, 0; a usage error exits 2 before any candidate runs.

Exit codes: 0 pass, 1 a budget was violated, 2 usage error (bad flags or arguments, an unreadable
or invalid --thresholds or --budgets file), 3 a budget was inconclusive, 4 the candidate log could
not be read or parsed (or the --shs-base-url fetch failed), 5 the baseline could not be read
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
      'app-id': { type: 'string', multiple: true },
      'attempt-id': { type: 'string' },
      baseline: { type: 'string' },
      'baseline-shs-base-url': { type: 'string' },
      'baseline-app-id': { type: 'string' },
      'baseline-attempt-id': { type: 'string' },
      'max-regression-pct': { type: 'string' },
      'regression-metric': { type: 'string' },
      'regression-budget': { type: 'string', multiple: true },
      budgets: { type: 'string' },
      'stage-regression-budget': { type: 'string', multiple: true },
      'stage-quality': { type: 'string' },
      'fail-on-introduced': { type: 'string' },
      redact: { type: 'boolean' },
      'export-html': { type: 'string' },
      impact: { type: 'string' },
      type: { type: 'string' },
      stage: { type: 'string' },
      thresholds: { type: 'string' },
      'normalize-path': { type: 'string', multiple: true },
      'ignore-conf': { type: 'string', multiple: true },
      'noise-band-pct': { type: 'string' },
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

function withEvidence({ appModel, skippedLines }) {
  appModel.evidenceAvailability = deriveEvidenceAvailability(appModel, { skippedLines });
  return { appModel, skippedLines };
}

async function collectWithEvidence(path) {
  return withEvidence(await collectRun(path));
}

// The provenance stamp: this CLI's own name and version, and the build id of the core it loaded
// (vendor-core/'s stamp or core/src's hash, see coreBuildId). The JSON report carries it as the
// `generator` block, the HTML export as one "<name> <version>" producer string.
function generatorInfo() {
  const { name, version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  return { name, version, buildId: coreBuildId(pkgDir) };
}

function exportProducer() {
  const { name, version } = generatorInfo();
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
const BASELINE_SHS_FLAG_BY_FIELD = { baseUrl: '--baseline-shs-base-url', appId: '--baseline-app-id', attemptId: '--baseline-attempt-id' };

// "<id>" or "<id>:<attempt>". The attempt ID charset has no ':', so the first one always splits.
function parseAppSpec(spec) {
  const at = spec.indexOf(':');
  return at === -1 ? { appId: spec, attemptId: undefined } : { appId: spec.slice(0, at), attemptId: spec.slice(at + 1) };
}

// Names the invalid fields of an SHS request in the flags the user typed, or returns null.
function shsRequestError(request, flagByField) {
  const { errors } = validateShsRequest(request);
  const invalid = Object.entries(errors).filter(([, message]) => message);
  if (invalid.length === 0) return null;
  return invalid.map(([field, message]) => `Invalid ${flagByField[field]}: ${message}`).join('\n');
}

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
// a candidate is named by its position (candidate-1, ...): log file names and app ids identify the run.
// loadBaseline() and each candidate's load() resolve to { appModel }, from a local log or a History Server.
async function runMultiLog({
  candidates, loadBaseline, budgets, thresholds, findingsFilter, redact, outPath, confKeys, confRedactRegex, normalizePath, ignoreConf, noiseBand,
}) {
  let baselineAppModel;
  try {
    ({ appModel: baselineAppModel } = await loadBaseline());
  } catch (e) {
    process.stderr.write(`${redact ? redactedFailure('The baseline', EXIT.BASELINE_UNREADABLE) : e.message}\n`);
    process.exitCode = EXIT.BASELINE_UNREADABLE;
    return;
  }
  const baselineCatalog = runFindings(baselineAppModel, thresholds).catalog;
  if (outPath) writeFileSync(outPath, '');
  const emit = (line) => {
    const text = `${JSON.stringify(line)}\n`;
    if (outPath) appendFileSync(outPath, text);
    else process.stdout.write(text);
  };

  let worstExit = 0;
  for (const [index, { name, load }] of candidates.entries()) {
    const log = redact ? `candidate-${index + 1}` : name;
    let line;
    try {
      const { appModel } = await unreadable(load(), EXIT.CANDIDATE_UNREADABLE);
      const catalog = runFindings(appModel, thresholds).catalog;
      const { comparison, output } = buildComparisonOutput(
        { label: 'baseline', appModel: baselineAppModel, catalog: baselineCatalog },
        { label: 'candidate', appModel, catalog },
        { redact, normalizePath, ignoreConf, confRedactRegex, noiseBand, generator: generatorInfo() },
      );
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
        candidate: { ...json, ...runOutputBlocks(appModel, { redact, thresholds, confKeys, confRedactRegex, generator: generatorInfo() }) },
        comparison: output,
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
  // One entry per --app-id: { appId, attemptId, name }, name being the --app-id value as given.
  let shsCandidates = [];
  if (usingShs) {
    if (positionals.length > 0) {
      return bail(`Pass either <event-log-file|rolling-log-dir> or --shs-base-url, not both.\n${USAGE}`, 2);
    }
    if (values['app-id'] === undefined) {
      return bail(`--shs-base-url requires --app-id.\n${USAGE}`, 2);
    }
    const specs = values['app-id'];
    if (values['attempt-id'] !== undefined && (specs.length > 1 || specs[0].includes(':'))) {
      return bail(`--attempt-id applies to a single --app-id; with several applications write --app-id <id>:<attempt>.\n${USAGE}`, 2);
    }
    for (const spec of specs) {
      const { appId, attemptId } = parseAppSpec(spec);
      if (attemptId === '') return bail(`Invalid --app-id: an attempt must follow ":" in "${spec}".\n${USAGE}`, 2);
      const message = shsRequestError({
        baseUrl: values['shs-base-url'], appId, attemptId: attemptId ?? values['attempt-id'],
      }, SHS_FLAG_BY_FIELD);
      if (message) return bail(`${message}\n${USAGE}`, 2);
      shsCandidates.push({ appId, attemptId: attemptId ?? values['attempt-id'], name: spec });
    }
  } else {
    if (positionals.length === 0 || (positionals.length > 1 && values.baseline === undefined && values['baseline-shs-base-url'] === undefined)) {
      return bail(USAGE, 2);
    }
    if (values['app-id'] !== undefined || values['attempt-id'] !== undefined) {
      return bail(`--app-id/--attempt-id require --shs-base-url.\n${USAGE}`, 2);
    }
  }

  const usingBaselineShs = values['baseline-shs-base-url'] !== undefined;
  if (usingBaselineShs) {
    if (values.baseline !== undefined) {
      return bail(`Pass either --baseline <path> or --baseline-shs-base-url, not both.\n${USAGE}`, 2);
    }
    if (values['baseline-app-id'] === undefined) {
      return bail(`--baseline-shs-base-url requires --baseline-app-id.\n${USAGE}`, 2);
    }
    const message = shsRequestError({
      baseUrl: values['baseline-shs-base-url'], appId: values['baseline-app-id'], attemptId: values['baseline-attempt-id'],
    }, BASELINE_SHS_FLAG_BY_FIELD);
    if (message) return bail(`${message}\n${USAGE}`, 2);
  } else if (values['baseline-app-id'] !== undefined || values['baseline-attempt-id'] !== undefined) {
    return bail(`--baseline-app-id/--baseline-attempt-id require --baseline-shs-base-url.\n${USAGE}`, 2);
  }
  const usingBaseline = values.baseline !== undefined || usingBaselineShs;

  if (values.format !== undefined && !['json', 'md', 'ndjson'].includes(values.format)) {
    return bail(`Invalid value for --format (expected "json", "md" or "ndjson").\n${USAGE}`, 2);
  }
  // Two or more candidates, or an explicit ndjson, run the multi-candidate mode.
  // A single --app-id is a single candidate, and --format ndjson stays a local-log mode for it.
  const multiLog = usingShs ? shsCandidates.length > 1 : (positionals.length > 1 || values.format === 'ndjson');
  if (multiLog) {
    if (!usingBaseline) {
      return bail(`${usingShs ? 'Several --app-id values' : '--format ndjson'} require --baseline or --baseline-shs-base-url.\n${USAGE}`, 2);
    }
    if (values.format !== undefined && values.format !== 'ndjson') {
      return bail(`Several candidates write NDJSON; --format ${values.format} cannot be combined with them.\n${USAGE}`, 2);
    }
    if (values['export-html'] !== undefined) {
      return bail(`--export-html writes one dashboard and cannot be combined with several candidates.\n${USAGE}`, 2);
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

  // Single source of truth for which flags need --baseline: append a future
  // flag here rather than adding its own OR-condition (easy to forget).
  const BASELINE_DEPENDENT_FLAGS = ['max-regression-pct', 'regression-metric', 'fail-on-introduced', 'regression-budget', 'budgets', 'normalize-path', 'ignore-conf', 'noise-band-pct', 'stage-regression-budget', 'stage-quality'];
  if (!usingBaseline && BASELINE_DEPENDENT_FLAGS.some((flag) => values[flag] !== undefined)) {
    return bail(`--max-regression-pct/--regression-metric/--regression-budget/--budgets/--stage-regression-budget/--stage-quality/--fail-on-introduced/--ignore-conf/--noise-band-pct/--normalize-path require --baseline or --baseline-shs-base-url.\n${USAGE}`, 2);
  }
  if (values['regression-metric'] !== undefined && values['max-regression-pct'] === undefined) {
    return bail(`--regression-metric requires --max-regression-pct.\n${USAGE}`, 2);
  }
  if (values['regression-metric'] !== undefined && !COMPARISON_METRIC_KEYS.includes(values['regression-metric'])) {
    return bail(`Unknown --regression-metric "${values['regression-metric']}" (expected one of: ${COMPARISON_METRIC_KEYS.join(', ')}).\n${USAGE}`, 2);
  }

  const budgets = {};
  const NUMERIC_BUDGET_FLAGS = {
    'max-runtime': 'maxRuntimeMs', 'max-spill': 'maxSpillGb', 'max-skew': 'maxSkewRatio',
    'max-failed-task-rate': 'maxFailedTaskRatePct', 'min-efficiency': 'minEfficiencyPct',
    'max-regression-pct': 'maxRegressionPct',
  };
  try {
    for (const [flag, field] of Object.entries(NUMERIC_BUDGET_FLAGS)) {
      if (values[flag] != null) budgets[field] = parseNonNegativeNumber(values[flag], `--${flag}`);
    }
  } catch (e) {
    return bail(`${e.message}\n${USAGE}`, 2);
  }
  // Only set when the user passed --regression-metric: evaluateBudgets() treats
  // "regressionMetric is set" as "caller asked for a regression check", so
  // defaulting it here would trip that guard on runs that touched neither flag.
  // checkRegression falls back to 'wallClock' itself once maxRegressionPct is set.
  if (values['regression-metric'] !== undefined) budgets.regressionMetric = values['regression-metric'];
  if (values['fail-on-introduced'] !== undefined) {
    try {
      budgets.failOnIntroduced = parseFailOnIntroduced(values['fail-on-introduced'], '--fail-on-introduced');
    } catch (e) {
      return bail(`${e.message}\n${USAGE}`, 2);
    }
  }

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

  if (values['stage-quality'] !== undefined && values['stage-regression-budget'] === undefined) {
    return bail(`--stage-quality requires --stage-regression-budget.\n${USAGE}`, 2);
  }
  if (values['stage-regression-budget'] !== undefined) {
    try {
      const stageBudgets = values['stage-regression-budget'].map(parseStageRegressionBudgetFlag);
      combineRegressionBudgets(stageBudgets.map((budget) => ({ origin: '--stage-regression-budget', budget })));
      budgets.stageRegressionBudgets = stageBudgets;
      if (values['stage-quality'] !== undefined) budgets.stageQualities = parseStageQualities(values['stage-quality'], '--stage-quality');
    } catch (e) {
      return bail(`${e.message}\n${USAGE}`, 2);
    }
  }

  let impactBand;
  let type;
  let stageId;
  try {
    if (values.impact !== undefined) impactBand = parseImpactBands(values.impact, '--impact');
    if (values.type !== undefined) type = parseFindingTypes(values.type, '--type');
    if (values.stage !== undefined) stageId = parseStageId(values.stage, '--stage');
  } catch (e) {
    return bail(`${e.message}\n${USAGE}`, 2);
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

  // Compiled before any log is parsed so a bad pattern is a usage error, not a late crash.
  const normalizePath = values['normalize-path'];
  if (normalizePath !== undefined) {
    try {
      compileNormalizePatterns(normalizePath);
    } catch (e) {
      return bail(`--normalize-path: ${e.message}\n`, 2);
    }
  }

  const ignoreConf = values['ignore-conf'];
  if (ignoreConf !== undefined) {
    try {
      compileConfIgnorePatterns(ignoreConf);
    } catch (e) {
      return bail(`--ignore-conf: ${e.message}\n`, 2);
    }
  }
  let noiseBand;
  if (values['noise-band-pct'] !== undefined) {
    const pct = Number(values['noise-band-pct']);
    if (values['noise-band-pct'].trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return bail(`--noise-band-pct needs a number from 0 to 100 (default ${DEFAULT_NOISE_BAND * 100}).\n${USAGE}`, 2);
    }
    noiseBand = pct / 100;
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

  const shsOpts = fetchImpl !== undefined ? { fetchImpl } : {};
  const loadBaseline = () => (usingBaselineShs
    ? resolveFromShs(values['baseline-shs-base-url'], values['baseline-app-id'], values['baseline-attempt-id'], shsOpts)
    : collectWithEvidence(values.baseline));

  if (multiLog) {
    const candidates = usingShs
      ? shsCandidates.map(({ appId, attemptId, name }) => ({
        name, load: () => resolveFromShs(values['shs-base-url'], appId, attemptId, shsOpts),
      }))
      : positionals.map((path) => ({ name: path, load: () => collectWithEvidence(path) }));
    return runMultiLog({
      candidates, loadBaseline, budgets, thresholds,
      findingsFilter, redact: values.redact, outPath: values.out,
      confKeys, confRedactRegex: values['conf-redact-regex'], normalizePath, ignoreConf, noiseBand,
    });
  }

  let appModel;
  let baselineAppModel;
  // Assigned by every branch below before it's read.
  let skippedLines;
  try {
    if (usingShs || usingBaselineShs) {
      const [{ appId, attemptId }] = usingShs ? shsCandidates : [{}];
      const candidatePromise = unreadable(usingShs
        ? resolveFromShs(values['shs-base-url'], appId, attemptId, shsOpts)
        : collectWithEvidence(positionals[0]), EXIT.CANDIDATE_UNREADABLE);
      // An SHS fetch (network) and a local parse (disk) are independent, so run them concurrently.
      // Local+local below is CPU work on both sides, so collectRunPair uses a worker thread for it.
      if (usingBaseline) {
        const [candidateResult, baselineResult] = await Promise.allSettled([
          candidatePromise, unreadable(loadBaseline(), EXIT.BASELINE_UNREADABLE),
        ]);
        // The baseline's failure wins, as it does for local logs (exit 5 outranks 4).
        if (baselineResult.status === 'rejected') throw baselineResult.reason;
        if (candidateResult.status === 'rejected') throw candidateResult.reason;
        ({ appModel, skippedLines } = candidateResult.value);
        baselineAppModel = baselineResult.value.appModel;
      } else {
        ({ appModel, skippedLines } = await candidatePromise);
      }
    } else {
      if (usingBaseline) {
        // Two big logs parse in parallel (the smaller on a worker thread). The baseline is settled
        // first, so a batch with both logs unreadable reports the worse exit code (5).
        const { baseline, candidate } = await collectRunPair(values.baseline, positionals[0]);
        const settled = (result, exitCode) => unreadable(
          result.status === 'fulfilled' ? Promise.resolve().then(() => withEvidence(result.value)) : Promise.reject(result.reason),
          exitCode,
        );
        baselineAppModel = (await settled(baseline, EXIT.BASELINE_UNREADABLE)).appModel;
        ({ appModel, skippedLines } = await settled(candidate, EXIT.CANDIDATE_UNREADABLE));
      } else {
        ({ appModel, skippedLines } = await unreadable(collectWithEvidence(positionals[0]), EXIT.CANDIDATE_UNREADABLE));
      }
    }
  } catch (e) {
    const exitCode = e.exitCode ?? EXIT.INTERNAL;
    const role = exitCode === EXIT.BASELINE_UNREADABLE ? 'The baseline' : 'The candidate';
    process.stderr.write(`${values.redact ? redactedFailure(role, exitCode) : e.message}\n`);
    process.exitCode = exitCode;
    return;
  }

  const catalog = runFindings(appModel, thresholds).catalog;

  if (exportHtmlDir !== undefined) {
    // The dashboard never tunes, so the export is the default-threshold analysis of the run.
    const tuned = tunedDetectors(thresholds) !== null;
    if (tuned) {
      process.stderr.write('--export-html: the exported dashboard uses the default detector thresholds; --thresholds applies to the report only.\n');
    }
    try {
      await writeHtmlExport(exportHtmlDir, appModel, tuned ? runFindings(appModel).catalog : catalog, skippedLines, { redact: values.redact });
    } catch (e) {
      process.stderr.write(`--export-html failed: ${e.message}\n`);
      process.exitCode = EXIT.INTERNAL;
      return;
    }
  }

  let comparison;
  let comparisonJson;
  if (usingBaseline) {
    const baselineCatalog = runFindings(baselineAppModel, thresholds).catalog;
    // The builder applies --redact: stage names in the comparison carry raw Spark stage text,
    // which --redact promises to pseudonymize.
    ({ comparison, output: comparisonJson } = buildComparisonOutput(
      { label: 'baseline', appModel: baselineAppModel, catalog: baselineCatalog },
      { label: 'candidate', appModel, catalog },
      { redact: values.redact, normalizePath, ignoreConf, confRedactRegex: values['conf-redact-regex'], noiseBand, generator: generatorInfo() },
    ));
  }

  const { markdown, json } = buildEvidenceReport(appModel, {
    redact: values.redact, findingsFilter, markdown: values.format === 'md', thresholds,
  });
  let output;
  if (values.format === 'md') {
    output = comparison ? `${markdown}${renderComparisonMarkdown(comparison, comparisonJson.verdict)}\n` : `${markdown}\n`;
  } else {
    const machineReadable = runOutputBlocks(appModel, {
      redact: values.redact, thresholds, confKeys, confRedactRegex: values['conf-redact-regex'],
      generator: generatorInfo(),
    });
    const payload = comparison
      ? { candidate: { ...json, ...machineReadable }, comparison: comparisonJson }
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
