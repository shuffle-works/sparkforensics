import { defineFindingWidget } from '@/view/finding-widget';
import { StageGroupRowBody } from './StageGroup';
import { tinyTaskModel } from './TinyTask.rows';

/** Flags every stage carrying a `tinyTask` finding (never just the worst one). */
export const TinyTask = defineFindingWidget(tinyTaskModel, { Row: StageGroupRowBody });
