/** The shuffle-partition count to try for a stage (`recommendPartitions`), in the one form
 * Shuffle I/O and Spill share. */
export function PartitionHint({ hint }: { hint: { recommended: number; current: number } }) {
  return (
    <p className="text-xs text-muted-foreground">
      Try <code>spark.sql.shuffle.partitions = {hint.recommended}</code> (now {hint.current} tasks; target 128 MB per
      partition)
    </p>
  );
}
