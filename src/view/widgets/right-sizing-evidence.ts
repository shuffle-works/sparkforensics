/** Whether a right-sizing row renders. The line above states the core counts and both durations;
 * only the Advanced model error is new. */
export function rightSizingRowShows(stated: boolean, advanced: boolean): boolean {
  return !stated || advanced;
}
