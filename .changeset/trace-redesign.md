---
"sparkforensics-web": minor
---

The dashboard has a new light and dark palette: a gray canvas with white panels in light, slate instead of near-black in dark, and an indigo accent in place of orange. Status colors now mark analysis status only, and neutral chart series use their own colors. The UI font is now Instrument Sans with JetBrains Mono for numbers and code. Both fonts ship with the app and are embedded in HTML exports, so no page requests a font from a third-party server.

The board keeps its layout. The verdict now shows the run's longest stages on a run clock, with the stage to fix first marked by its step code (F1, F2, F3). The same code appears on that finding's row and in the stage table. Tags are small square chips, metric tiles have gauges, and report widgets share one card style. The landing page, the run comparison page and the HTML export use the same look.
