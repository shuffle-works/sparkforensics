import { defineFindingWidget } from '@/view/finding-widget';
import { StageGroupRowBody } from './StageGroup';
import { stageShapeModel } from './StageShape.rows';

/** Per-stage stage-shape findings: flags every stage carrying a `stageShape` finding (never just the
 * worst one). */
export const StageShape = defineFindingWidget(stageShapeModel, { Row: StageGroupRowBody });
