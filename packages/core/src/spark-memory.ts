// Parse a Spark memory-size string to MiB. Spark's JVM-memory configs use bytesConf(ByteUnit.MiB),
// so a bare number means MiB. A k/m/g/t suffix sets the unit (trailing "b" redundant); a lone "b"
// ("10b") means bytes.
export function parseSparkMemoryMB(value: unknown): number | null {
  if (value == null) return null;
  const m = String(value).trim().toLowerCase().match(/^([\d.]+)\s*([kmgt]?)(b?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case 'k': return Math.round(n / 1024);
    case 'g': return Math.round(n * 1024);
    case 't': return Math.round(n * 1024 * 1024);
    case 'm': return Math.round(n);
    default: return m[3] === 'b' ? Math.round(n / (1024 * 1024)) : Math.round(n);
  }
}
