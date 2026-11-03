---
"sparkforensics-web": patch
---

The dashboard decides routing and focus from a layout of its cards and rows, not from what is mounted. A route shows its tab, opens the cards it lands in and focuses the row as the row mounts, so it no longer depends on the order components mount. The board mounts only the tab that is showing and the card bodies that are open, and keeps each widget's page, sort and the Stage Summary filter for the run. Text in a collapsed card is not on the page for the browser's find until the card is open. The `j` and `k` shortcuts step through the layout's rows. The plan graph derives its expand dialog and node selection while rendering, keeps the 24 most recent models, and decides its mini-map where the viewport is measured.
