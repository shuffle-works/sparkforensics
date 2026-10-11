import { planNodesOfStage } from './stage-plan-nodes.ts';
import type { PlanNode, SqlExecution, Stage } from './types.ts';

// Plan operators that hand rows to a Python worker process: the row-at-a-time and Arrow Python UDF
// evaluators, the pandas/Arrow grouped and map operators, and the PythonRDD scan of an RDD
// pipeline. A suffixed name is a variant of the same operator (BatchEvalPythonUDTF,
// FlatMapGroupsInPandasWithState). Spark 4.1 renamed AggregateInPandas and WindowInPandas to
// ArrowAggregatePython and ArrowWindowPython. Spark prefixes a whole-stage-codegen child's name
// with "*(n) " in some plan strings.
const PYTHON_PLAN_NODE = /^(?:\*\(\d+\)\s*)?(?:PythonRDD|BatchEvalPython|ArrowEvalPython|ArrowAggregatePython|ArrowWindowPython|\w+InPandas|\w+InArrow)\w*\b/;

// The row-at-a-time Python UDF evaluator: each row is pickled to a Python worker and its result
// pickled back. The Arrow-based ArrowEvalPython is deliberately not matched, and neither are the
// UDTF variants (BatchEvalPythonUDTF), which spark.sql.execution.pythonUDF.arrow.enabled does not
// govern.
const BATCH_EVAL_PYTHON_NODE = /^(?:\*\(\d+\)\s*)?BatchEvalPython$/;

/** True for a plan node that runs row-at-a-time Python UDFs (BatchEvalPython). */
export function isBatchEvalPythonNode(node: Pick<PlanNode, 'name'>): boolean {
  return BATCH_EVAL_PYTHON_NODE.test(node.name ?? '');
}

// An RDD lambda or map function has no SQL plan to match, and a stage whose plan could not be
// matched is left with nothing but its name and call site.
const PYTHON_STAGE_NAME = /PythonRDD/;
const PYTHON_STAGE_DETAILS = /org\.apache\.spark\.api\.python\./;

/** True when the stage ran Python code in a worker process: the union of a Python operator among
 * the plan nodes attributed to it (catches Python UDFs inside SQL) and the stage's own name or
 * call site naming PythonRDD / org.apache.spark.api.python (catches RDD lambdas, which have no
 * plan, and stages that cannot be matched to one). The executor CPU time of such a stage misses
 * the worker process's CPU. */
export function isPythonStage(stage: Stage, sql: Map<number, SqlExecution>): boolean {
  if (PYTHON_STAGE_NAME.test(stage.name ?? '') || PYTHON_STAGE_DETAILS.test(stage.details ?? '')) return true;
  return planNodesOfStage(stage, sql).some((node) => PYTHON_PLAN_NODE.test(node.name ?? ''));
}
