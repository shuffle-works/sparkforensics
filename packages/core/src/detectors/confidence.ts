// Fingerprint matching compares operator + metric names only, not literal values or expr IDs
// (see the finding's validationRequired text), so a small pattern repeated the bare minimum
// number of times is the case most likely to be coincidental rather than real duplicated work.
// A bigger matched subtree, or more repeats, are each on their own strong corroborating evidence
// that the match is real: the odds of two semantically-different query branches producing an
// identical operator-name sequence shrink fast as the sequence grows or repeats.
export function duplicateSubtreeConfidence(
  subtreeSize: number,
  occurrences: number,
  thresholds: { minSubtreeSize: number; minOccurrences: number },
): 'low' | 'medium' | 'high' {
  if (subtreeSize <= thresholds.minSubtreeSize && occurrences <= thresholds.minOccurrences) return 'low';
  if (subtreeSize >= thresholds.minSubtreeSize * 2 || occurrences >= thresholds.minOccurrences + 2) return 'high';
  return 'medium';
}

// Both cachedRatio and diskRatio are percentages of an RDD's partition/byte count: with few
// partitions, one partition flipping cached/evicted (or disk-resident/memory-resident) swings the
// reported percentage by a large amount, so the point estimate is noisy. More partitions average
// that noise out into a stable ratio. numPartitions is the only sample-size signal
// DetectorRddInfo carries, so it drives confidence for both variants rather than a flat guess.
// 10/50 mirror the other "trust the sample" cutoffs (skew's minTasksForP95: 20,
// coreLocality's minTasks: 50).
export function cacheSampleConfidence(numPartitions: number): 'low' | 'medium' | 'high' {
  if (numPartitions < 10) return 'low';
  if (numPartitions >= 50) return 'high';
  return 'medium';
}

// A ratio just past ratioWarn is the case most likely to be ordinary task-duration variance
// rather than real skew; a ratio many multiples past it (a 50x P95/median vs. a 3.1x one) is
// unambiguous. 1.5x/5x mirror the other "just past the floor vs. clearly past it" splits
// (duplicateSubtreeConfidence's 2x, cacheSampleConfidence's 10/50-partition cutoffs).
export function skewConfidence(ratio: number, ratioWarn: number): 'low' | 'medium' | 'high' {
  if (ratio <= ratioWarn * 1.5) return 'low';
  if (ratio >= ratioWarn * 5) return 'high';
  return 'medium';
}

// warnPct100/lowInfoPct100 are this detector's own two thresholds; scale confidence as a multiple
// of whichever one gates the branch that fired, the same way skewConfidence scales off ratioWarn.
// High-GC: a pct just past warnPct100 (10%) is likely normal variance, 3x past it is unambiguous.
// Low-GC ("cost", over-provisioned): a pct just under lowInfoPct100 (5%) is borderline, a pct near
// zero is unambiguous idle GC.
export function gcConfidence(
  pct: number,
  thresholds: { warnPct100: number; lowInfoPct100: number },
  direction: 'high' | 'low',
): 'low' | 'medium' | 'high' {
  if (direction === 'high') {
    if (pct <= thresholds.warnPct100 * 1.5) return 'low';
    if (pct >= thresholds.warnPct100 * 3) return 'high';
    return 'medium';
  }
  if (pct >= thresholds.lowInfoPct100 * 0.66) return 'low';
  if (pct <= thresholds.lowInfoPct100 * 0.2) return 'high';
  return 'medium';
}

// warnFloor gates the finding, so a value just past it is the weakest evidence this detector can
// produce. highFloor is critPct: straggler's own second (speculative-share) tier, 2x warnPct
// (0.10 -> 0.20); reused as the high-confidence bar for the stragglerShare path too since that
// metric has no critical tier of its own but is the same 0-1 task-share magnitude.
export function stragglerConfidence(shareValue: number, warnFloor: number, highFloor: number): 'low' | 'medium' | 'high' {
  if (shareValue < warnFloor * 1.5) return 'low';
  if (shareValue >= highFloor) return 'high';
  return 'medium';
}

// minWasteMs is speculationWaste's own floor; a run that barely clears it (under 1.5x) is the
// weakest case, one that clears it several times over (4x, i.e. 4 minutes against a 1-minute
// floor) is unambiguous.
export function speculationWasteConfidence(wastedMs: number, minWasteMs: number): 'low' | 'medium' | 'high' {
  if (wastedMs <= minWasteMs * 1.5) return 'low';
  if (wastedMs >= minWasteMs * 4) return 'high';
  return 'medium';
}

// The finding already gates on wastedMBSeconds > wasteBufferMultiplier * usedMBSeconds, i.e. a
// ratio of 1 at the floor; scale confidence off that same ratio the way skewConfidence scales off
// ratioWarn, instead of introducing a second, unrelated multiplier.
export function memoryWasteConfidence(wastedMBSeconds: number, usedMBSeconds: number, wasteBufferMultiplier: number): 'low' | 'medium' | 'high' {
  const ratio = usedMBSeconds > 0 ? wastedMBSeconds / (wasteBufferMultiplier * usedMBSeconds) : Infinity;
  if (ratio <= 1.5) return 'low';
  if (ratio >= 3) return 'high';
  return 'medium';
}

// Two independent weak spots can each undercut this finding: a ratio just past warnRatio (could
// be one bad stage), or too few sampled tasks (mirrors cacheSampleConfidence's use of
// numPartitions as a sample-size signal). Report whichever signal is weaker rather than
// averaging them away. critRatio is this detector's own existing second tier, reused directly as
// the ratio high-bar; minTasks*2/*4 mirror the same "2x floor is still weak, 4x is strong" spread
// used by the other helpers here.
export function coreLocalityConfidence(
  ratio: number,
  totalTasks: number,
  thresholds: { minTasks: number; warnRatio: number; critRatio: number },
): 'low' | 'medium' | 'high' {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const ratioTier = ratio < thresholds.warnRatio * 1.5 ? 'low' : ratio >= thresholds.critRatio ? 'high' : 'medium';
  const sampleTier = totalTasks < thresholds.minTasks * 2 ? 'low' : totalTasks >= thresholds.minTasks * 4 ? 'high' : 'medium';
  return rank[ratioTier] <= rank[sampleTier] ? ratioTier : sampleTier;
}

// warningPct/criticalPct are this detector's own two tiers (0.30/0.60); a churn rate just past
// warningPct is the borderline call the impact-band split already treats as the weaker tier, so
// reuse criticalPct directly as the high-confidence bar instead of inventing a third figure.
export function autoscalingChurnConfidence(shortLivedPct: number, warningPct: number, criticalPct: number): 'low' | 'medium' | 'high' {
  if (shortLivedPct <= warningPct * 1.5) return 'low';
  if (shortLivedPct >= criticalPct) return 'high';
  return 'medium';
}

// minExecutions is the bare minimum occurrence count this detector will even emit a finding for;
// a match at exactly that count is the weakest reuse signal (as likely to be coincidental overlap
// as real shared work), while 3x the floor is several independent executions all hitting the same
// relation/composite shape, unambiguous. Mirrors duplicateSubtreeConfidence's occurrences handling
// for the same reason: repetition count is the strength signal for a structural-match detector.
export function cachingReuseConfidence(occurrences: number, minExecutions: number): 'low' | 'medium' | 'high' {
  if (occurrences <= minExecutions) return 'low';
  if (occurrences >= minExecutions * 3) return 'high';
  return 'medium';
}
