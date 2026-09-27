// Plain-language help per finding tag: the expansion the tag stands for and a one-line description
// of what it means. Shared by the dashboard (tag tooltips, verdict "What's happening") and the
// comparison verdict, which names finding categories by their expansion on every path.
type TagHelp = {
  expansion: string;
  description: string;
};

export const TAG_HELP: Record<string, TagHelp> = {
  INCMP: {
    expansion: 'Incomplete run',
    description: 'This event log never recorded an application-end event, so other findings and metrics reflect only what was captured.',
  },
  SKEW: {
    expansion: 'Task skew',
    description: 'A small number of tasks take much longer than their peers.',
  },
  SHFL: {
    expansion: 'Shuffle I/O',
    description: 'Tasks are moving a large amount of intermediate data between stages.',
  },
  SPILL: {
    expansion: 'Memory and disk spill',
    description: 'Tasks are writing data out of memory, which slows execution.',
  },
  GC: {
    expansion: 'Garbage collection pressure',
    description: 'Tasks are spending an unusually large share of time reclaiming memory.',
  },
  COLD: {
    expansion: 'Executor cold start',
    description: 'New executors are taking time to become available for work.',
  },
  UTIL: {
    expansion: 'Low utilization',
    description: 'Allocated executors are idle for a large share of the application run.',
  },
  MEM: {
    expansion: 'Memory utilization',
    description: 'Executor memory or core capacity may be over- or under-provisioned.',
  },
  LOCAL: {
    expansion: 'Core usage locality',
    description: 'Tasks are running without process- or node-local data placement more than expected.',
  },
  HOST: {
    expansion: 'Slow host',
    description: 'One executor is substantially slower than its peers.',
  },
  FAIL: {
    expansion: 'Failed tasks',
    description: 'Tasks are failing often enough to affect the stage.',
  },
  STRAG: {
    expansion: 'Straggler tasks',
    description: 'A few tasks are much slower than the rest of their stage.',
  },
  SPEC: {
    expansion: 'Speculation waste',
    description: 'Speculative task attempts used a lot of executor time without confirming a genuine straggler.',
  },
  RETRY: {
    expansion: 'Retry waste',
    description: 'Repeated task attempts are consuming avoidable execution time.',
  },
  TINY: {
    expansion: 'Tiny tasks',
    description: 'Many very short tasks are adding scheduling overhead.',
  },
  SFAIL: {
    expansion: 'Failed stage',
    description: 'A stage attempt failed outright.',
  },
  PART: {
    expansion: 'Partition sizing',
    description: 'Shuffle partitions are too large, too uneven, or too few for the work.',
  },
  SLOW: {
    expansion: 'Stage slowness',
    description: 'A stage is slow overall without a more specific diagnosed cause.',
  },
  SHAPE: {
    expansion: 'Stage shape',
    description: 'The stage has an inefficient task count, output shape, or task-to-stage balance.',
  },
  CACHE: {
    expansion: 'Caching opportunity',
    description: 'A reusable dataset may benefit from being persisted between stages.',
  },
  CSTOR: {
    expansion: 'Cache storage',
    description: 'A persisted dataset is not fully cached in memory or is spilling to disk.',
  },
  CHRN: {
    expansion: 'Autoscaling churn',
    description: 'Executors are being stood up and torn down again before they can do useful work.',
  },
  JOBS: {
    expansion: 'Job failure rate',
    description: 'A large share of completed jobs did not succeed.',
  },
  CFG: {
    expansion: 'Configuration audit',
    description: 'Configuration settings may cause reliability or efficiency problems.',
  },
  PLAN: {
    expansion: 'Plan advisor',
    description: 'The SQL execution plan has a pattern worth reviewing.',
  },
  BROADCASTSIZING: {
    expansion: 'Broadcast sizing',
    description: 'A broadcast join threshold or hint may be misconfigured for this query.',
  },
};
