---
"sparkforensics-web": patch
---

Every verdict step and Findings row opens its own "Show evidence" panel, showing only its own finding. A second finding of a type no longer sends you to another finding's panel. A route from the Stage Summary, the stage dialog or a group member's row opens the panel that holds its finding, or the type's full card when no step or row holds it. The Stragglers panel shows the straggling task count and the stage's task duration spread, with a histogram. The Slow Executor Host panel shows the executor's measured amount and the Nested Loop Joins panel the join node, type, condition and input rows. The empty-panel test counts a panel with only a stage chip, stage name or call site as empty.
