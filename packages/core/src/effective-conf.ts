// The effective Spark configuration of a run for the CLI's JSON output, so a caller can check
// that a --conf overlay took effect. Every key is listed; a value is withheld when the key matches
// a secret pattern, and credentials inside URL-like values are stripped. A withheld key is shown
// as present with no value, and no derivative of the value (no hash, length or prefix) is emitted.
import type { SparkAppInfo } from './types.ts';

export const EFFECTIVE_CONF_SCHEMA_VERSION = 1;

/** Spark's default spark.redaction.regex, in JS syntax (the JVM pattern is `(?i)` + this). */
export const DEFAULT_SECRET_PATTERN = 'secret|password|token|access[.]?key';
const REDACTED = '[redacted]';

export interface EffectiveConf {
  schemaVersion: number;
  /** Key -> value for every listed key that is not withheld. */
  values: Record<string, string>;
  /** Keys present in the log whose value is withheld. */
  maskedKeys: string[];
  /** With a key filter: requested keys the log's Spark Properties do not contain. */
  absentKeys: string[];
  /** Which patterns decided what to withhold. */
  redaction: {
    defaultPattern: string;
    /** The job's own spark.redaction.regex, when the log records one. */
    jobPattern: string | null;
    /** False when jobPattern cannot be evaluated here: every value is then withheld. */
    jobPatternUsable: boolean;
    userPattern: string | null;
  };
}

export interface EffectiveConfOptions {
  /** Narrow the output to these keys. */
  keys?: string[];
  /** An extra pattern (JVM or JS syntax, matched case-sensitively unless it starts with (?i)). */
  userPattern?: string;
  /** Also withhold the identifying values a redacted report pseudonymizes: host names and the app name. */
  redactIdentifiers?: boolean;
}

/** Compiles a JVM regex, which may start with inline flags such as (?i), as a JS RegExp. Null when
 * it uses syntax JS lacks. */
export function compileJvmPattern(source: string): RegExp | null {
  const lead = /^\(\?([a-z]+)\)/.exec(source);
  const flags = new Set<string>();
  let body = source;
  if (lead) {
    body = source.slice(lead[0].length);
    for (const f of lead[1]) {
      if (f === 'i' || f === 'm' || f === 's') flags.add(f);
      else if (f !== 'u') return null;
    }
  }
  try { return new RegExp(body, [...flags].join('')); } catch { return null; }
}

// Sensitive query/parameter names in a URL-like value: signatures of pre-signed and SAS URLs.
const SIGNATURE_PARAMS = 'sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential';

/** Strips credentials from a value that looks like a URL: userinfo (user:password@host), JDBC-style
 * password= parameters and signature query parameters (Azure SAS sig=, pre-signed signatures). */
export function stripUrlCredentials(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.includes('://')) return value;
  return value
    .replace(/(:\/\/)[^/\s@?#,]*@/g, `$1${REDACTED}@`)
    .replace(/((?:^|[?&;,\s])(?:password|passwd|pwd)=)[^;&,\s]*/gi, `$1${REDACTED}`)
    .replace(new RegExp(`((?:^|[?&;,\\s])(?:${SIGNATURE_PARAMS})=)[^;&,\\s]*`, 'gi'), `$1${REDACTED}`);
}

const IDENTIFYING_KEY = /(?:\.host|\.hostname|^spark\.app\.name)$/i;

/** The run's Spark Properties as the CLI reports them; null when the log recorded none. */
export function buildEffectiveConf(app: SparkAppInfo | null, options: EffectiveConfOptions = {}): EffectiveConf | null {
  const config = app?.config;
  if (config == null) return null;
  const defaultPattern = new RegExp(DEFAULT_SECRET_PATTERN, 'i');
  const jobSource = config['spark.redaction.regex'] ?? null;
  const jobPattern = jobSource != null ? compileJvmPattern(jobSource) : null;
  const jobPatternUsable = jobSource == null || jobPattern != null;
  const userSource = options.userPattern ?? null;
  const userPattern = userSource != null ? compileJvmPattern(userSource) : null;
  if (userSource != null && userPattern == null) throw new Error(`invalid secret pattern: ${userSource}`);

  const wanted = options.keys ? new Set(options.keys) : null;
  const values: Record<string, string> = {};
  const maskedKeys: string[] = [];
  for (const key of Object.keys(config).sort()) {
    if (wanted && !wanted.has(key)) continue;
    const value = config[key];
    // Spark applies spark.redaction.regex to the key and the value; the default pattern names keys.
    const masked = !jobPatternUsable
      || defaultPattern.test(key)
      || (jobPattern?.test(key) ?? false) || (jobPattern?.test(value) ?? false)
      || (userPattern?.test(key) ?? false) || (userPattern?.test(value) ?? false)
      || (options.redactIdentifiers === true && IDENTIFYING_KEY.test(key));
    if (masked) maskedKeys.push(key);
    else values[key] = stripUrlCredentials(value);
  }
  return {
    schemaVersion: EFFECTIVE_CONF_SCHEMA_VERSION,
    values,
    maskedKeys,
    absentKeys: wanted ? [...wanted].filter((k) => !(k in config)).sort() : [],
    redaction: { defaultPattern: DEFAULT_SECRET_PATTERN, jobPattern: jobSource, jobPatternUsable, userPattern: userSource },
  };
}
