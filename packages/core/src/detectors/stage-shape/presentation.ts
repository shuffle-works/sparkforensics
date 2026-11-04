import type { FindingPresentation } from '../../finding-presentation.ts';

export const presentation = {
  stageShape: {
    name: 'stage shape',
    tag: 'SHAPE',
    family: 'speed',
    pitch: 'A stage runs too few tasks for its cores, or its output dwarfs its input.',
    thresholdSummary: (t) => `under ${t.pRatioMax} tasks per core, output over ${t.oiRatioMax}× input, or one task spanning over ${Math.round(t.stageShareMin * 100)}% of the stage's wall-clock at over ${t.skewWarn}× the median task`,
    actionLabel(f) {
      switch (f.rule) {
        case 'lowParallelism': return 'Increase parallelism';
        case 'dataExplosion': return 'Check for exploding join';
        case 'taskStageSkew': return 'Fix straggler task';
      }
      return undefined;
    },
    genericRecommendation(f) {
      switch (f.rule) {
        case 'lowParallelism': return 'Too few tasks run relative to the cores available, leaving cluster capacity idle: repartition to use more of it.';
        case 'dataExplosion': return 'Output volume far exceeds input volume: check for an exploding join or a cross product.';
        case 'taskStageSkew': return 'A single straggler task gates the whole stage\'s wall-clock duration.';
      }
      return undefined;
    },
  },
} as const satisfies {
  stageShape: FindingPresentation<'stageShape'>;
};
