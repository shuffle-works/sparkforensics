import { defineFindingWidget } from '@/view/finding-widget';
import { skewModel } from './Skew.rows';
import { StageGroupRowBody } from './StageGroup';

/** Per-stage task-duration skew board: flags every stage carrying a `skew` finding (never just the
 * worst one). */
export const Skew = defineFindingWidget(skewModel, { Row: StageGroupRowBody });
