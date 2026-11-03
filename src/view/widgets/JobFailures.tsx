import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { jobFailuresModel, type JobFailuresRow } from './JobFailures.rows';

function Row({ row: { finding, stated, showTaskContext } }: FindingRowProps<JobFailuresRow>) {
  const { failedJobs, totalJobs, failedTasks, totalTasks, taskFailureRate, value } = finding;
  return (
    <>
      <p>
        Failure rate: <strong>{value}%</strong>{stated ? null : <> ({failedJobs} of {totalJobs} completed jobs)</>}
      </p>
      {showTaskContext ? (
        <p className="text-xs text-muted-foreground">
          Task-failure context: {failedTasks} of {totalTasks} tasks failed ({taskFailureRate}%).
        </p>
      ) : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** App-level job-failure-rate rollup, complementing the per-stage Failed Tasks card. One row, no
 * stage pill, no pagination. */
export const JobFailures = defineFindingWidget(jobFailuresModel, { Row });
