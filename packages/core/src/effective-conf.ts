// The effective Spark configuration of a run for the CLI's JSON output, so a caller can check
// that a --conf overlay took effect. Every key is listed; a value is withheld when the key or the
// value matches a secret pattern, and credentials inside URL-like values are stripped. A withheld
// key is shown as present with no value, and no derivative of the value (no hash, length or
// prefix) is emitted.
import type { SparkAppInfo } from './types.ts';

export const EFFECTIVE_CONF_SCHEMA_VERSION = 1;

/** Spark's default spark.redaction.regex, in JS syntax (the JVM pattern is `(?i)` + this). */
export const DEFAULT_SECRET_PATTERN = 'secret|password|token|access[.]?key';
/** Further credential names no Spark default covers, tested on keys (Azure `fs.azure.account.key.*`,
 * `apiKey`, `pwd`, a bare `pass` or `sas` segment, `credential`). */
export const EXTRA_SECRET_KEY_PATTERN = 'passwd|pwd|(?:^|[._-])pass(?:[._-]|$)|api[._-]?key|account[._-]?key|private[._-]?key|credential|(?:^|[._-])sas(?:[._-]|$)|(?:^|[._-])sig(?:nature)?(?:[._-]|$)';
const REDACTED = '[redacted]';

export interface EffectiveConf {
  schemaVersion: number;
  /** Key -> value for every listed key that is not withheld. */
  values: Record<string, string>;
  /** Keys present in the log whose value is withheld. */
  maskedKeys: string[];
  /** With a key filter: requested keys the log's Spark Properties do not contain. */
  absentKeys: string[];
}

export interface EffectiveConfOptions {
  /** Narrow the output to these keys. */
  keys?: string[];
  /** An extra pattern (JVM or JS syntax, matched case-sensitively unless it starts with (?i)). */
  userPattern?: string;
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

// A `name=value` credential parameter in any value (a JDBC or ODBC string, a JVM option, a query
// string): `password`, `pwd`, `pass`, `apikey`, `accountkey`, `sas`, `sig` and the like, alone or as
// the tail of a longer name (`-Djavax.net.ssl.keyStorePassword=`).
const CREDENTIAL_PARAM = new RegExp(
  '((?:^|[\\s;&,?:"\'(]|-D)(?:[\\w.-]*?(?:password|passwd|pwd|secret|token|api[_.-]?key|account[_.-]?key|access[_.-]?key|private[_.-]?key)|pass|sas|credential|'
  + `${SIGNATURE_PARAMS})\\s*=\\s*)("[^"]*"|'[^']*'|[^;&,\\s"']*)`, 'gi');

/** Strips credentials from a value: `name=value` credential parameters anywhere (JDBC
 * `password=`/`pwd=`/`pass=`, `apiKey=`, signature parameters such as Azure SAS `sig=`), and, in a
 * value that looks like a URL, userinfo (user:password@host) and the Oracle thin form
 * (jdbc:oracle:thin:user/password@host). */
export function stripUrlCredentials(value: string): string {
  const urlLike = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('://');
  const withoutUserinfo = urlLike
    ? value
      .replace(/(:\/\/)[^/\s@?#,]*@/g, `$1${REDACTED}@`)
      .replace(/^((?:[a-z][a-z0-9+.-]*:)+[^\s:/@]+\/)[^\s@]+@/i, `$1${REDACTED}@`)
    : value;
  return withoutUserinfo.replace(CREDENTIAL_PARAM, `$1${REDACTED}`);
}

/** The run's Spark Properties as the CLI reports them; null when the log recorded none. */
export function buildEffectiveConf(app: SparkAppInfo | null, options: EffectiveConfOptions = {}): EffectiveConf | null {
  const config = app?.config;
  if (config == null) return null;
  const defaultPattern = new RegExp(DEFAULT_SECRET_PATTERN, 'i');
  const extraKeyPattern = new RegExp(EXTRA_SECRET_KEY_PATTERN, 'i');
  const jobSource = config['spark.redaction.regex'] ?? null;
  const jobPattern = jobSource != null ? compileJvmPattern(jobSource) : null;
  // A job pattern this runtime cannot evaluate withholds every value rather than guess.
  const jobPatternUsable = jobSource == null || jobPattern != null;
  const userSource = options.userPattern ?? null;
  const userPattern = userSource != null ? compileJvmPattern(userSource) : null;
  if (userSource != null && userPattern == null) throw new Error(`invalid secret pattern: ${userSource}`);

  const wanted = options.keys ? new Set(options.keys) : null;
  const values: Record<string, string> = {};
  const maskedKeys: string[] = [];
  const matches = (pattern: RegExp | null, key: string, value: string) => (pattern?.test(key) ?? false) || (pattern?.test(value) ?? false);
  for (const key of Object.keys(config).sort()) {
    if (wanted && !wanted.has(key)) continue;
    const value = config[key];
    // Spark applies its redaction pattern to the key and the value.
    const masked = !jobPatternUsable
      || matches(defaultPattern, key, value) || extraKeyPattern.test(key) || matches(jobPattern, key, value) || matches(userPattern, key, value);
    if (masked) maskedKeys.push(key);
    else values[key] = stripUrlCredentials(value);
  }
  return {
    schemaVersion: EFFECTIVE_CONF_SCHEMA_VERSION,
    values,
    maskedKeys,
    absentKeys: wanted ? [...wanted].filter((k) => !(k in config)).sort() : [],
  };
}
