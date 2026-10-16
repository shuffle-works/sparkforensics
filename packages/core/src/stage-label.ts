// A path inside a stage name: an absolute path, optionally behind a URI scheme and authority
// (`hdfs://nn/...`). It starts at the beginning of the name or after a space, quote, bracket, `=`
// or `,`, so a `/` inside a word ("a/b") is never taken for one. A `:` ends the path, which leaves
// a trailing `:<line>` in place.
const PATH_IN_STAGE_NAME = /(?<![^\s"'(\[=,])(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]*)?(?:\/[^\s/:"')\]]+)+/g;

/** A stage name for display and output: every path in it reduced to its last segment, so the
 * directories of the job's call site (a YARN container directory such as
 * `.../usercache/<user>/appcache/<app>/container_<id>/`, a home directory) and the user name in
 * them never reach the output. `collect at /home/jdoe/jobs/etl.py:42` reads `collect at etl.py:42`.
 * Display only: `normalizeStageName` stays the stage identity, so stage pairing does not move. */
export function stageDisplayLabel(name: string): string {
  return name.replace(PATH_IN_STAGE_NAME, (path) => path.slice(path.lastIndexOf('/') + 1));
}
