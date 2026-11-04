import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'schema', 'cli-envelope.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(schema);
/** @typedef {import('ajv/dist/2020.js').ValidateFunction} Validate */
/** @typedef {import('@sparkforensics/core/node').CliEnvelope} CliEnvelope */
/** @typedef {Omit<CliEnvelope, 'run'> & { log: string, status: string, exitCode: number, error?: string, run: CliEnvelope['run'] | null }} NdjsonLine One `--format ndjson` line: the envelope per log, `run` null when that log failed. */

// addSchema registers both ids above, so getSchema always finds them.
const validateEnvelope = /** @type {Validate} */ (ajv.getSchema(schema.$id));
const validateLine = /** @type {Validate} */ (ajv.getSchema(`${schema.$id}#/$defs/ndjsonLine`));

/** @param {Validate} validate @param {unknown} value @param {string} label */
function assertValid(validate, value, label) {
  if (!validate(value)) throw new Error(`${label} does not match cli-envelope.schema.json: ${ajv.errorsText(validate.errors)}`);
}

/**
 * Parses the CLI's single-run JSON, checks it against the published schema, and returns the envelope.
 * @param {string} stdout
 * @returns {CliEnvelope}
 */
export function parseEnvelope(stdout) {
  const envelope = JSON.parse(stdout);
  assertValid(validateEnvelope, envelope, 'The CLI JSON');
  return envelope;
}

/** The `run` report of a single-run JSON output (schema-checked). @param {string} stdout */
export function parseRun(stdout) {
  return parseEnvelope(stdout).run;
}

/**
 * The lines of `--format ndjson` output, each checked against the schema's ndjsonLine.
 * @param {string} stdout
 * @returns {NdjsonLine[]}
 */
export function parseNdjsonLines(stdout) {
  return stdout.split('\n').filter(Boolean).map((text, i) => {
    const line = JSON.parse(text);
    assertValid(validateLine, line, `NDJSON line ${i + 1}`);
    return line;
  });
}
