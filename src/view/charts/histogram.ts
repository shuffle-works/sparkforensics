export function buildHistogram(values: number[], bins: number): {labels: number[]; data: number[]} {
  if (values.length === 0) return { labels: [], data: [] };
  let min = values[0], max = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  const binSize = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) counts[Math.min(Math.floor((v - min) / binSize), bins - 1)]++;
  const labels = counts.map((_, i) => Math.round(min + i * binSize));
  return { labels, data: counts };
}
