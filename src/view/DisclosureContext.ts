import { createContext, useContext } from 'react';

/**
 * Whether the nearest collapsible disclosure (a `WidgetCard`) is currently
 * open. Defaults to `true` so charts rendered outside any disclosure (dialogs,
 * non-collapsible cards) mount normally. `ChartFrame` reads this to avoid
 * mounting a Recharts `ResponsiveContainer` while hidden inside a collapsed
 * card: `keepMounted` keeps that card's body in the DOM, so a chart there would
 * be measured at 0×0 and log Recharts' "width(0) and height(0)" warning.
 */
export const DisclosureOpenContext = createContext(true);

export const useDisclosureOpen = (): boolean => useContext(DisclosureOpenContext);
