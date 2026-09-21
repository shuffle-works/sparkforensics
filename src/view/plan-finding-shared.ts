// --plan-aggregate is dedicated to plan-level data so it stays distinguishable
// from impact band states. As TagBadge's `className`, tailwind-merge lets it win
// over the impact band variant's bg-*/text-* while the impact dot stays
// impact-colored. Tint is /8 so the violet text keeps WCAG AA >=4.5:1 on the
// composited pill background in both themes.
export const PLAN_TAG_CLASS = 'bg-plan-aggregate/8 text-plan-aggregate';
