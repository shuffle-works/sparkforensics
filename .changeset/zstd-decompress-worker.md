---
"sparkforensics": patch
"sparkforensics-server": patch
---

Parser: a dropped zstd event log now decompresses in a second web worker while the parse worker
parses earlier output, instead of both taking turns on one thread. A window of three read slices
bounds the output queued between the two workers, and buffers move between them by transfer. On
the largest real log (138 MB compressed, 3.56 GB decompressed) the median browser parse time over
six paired runs fell from 7.5s to 6.1s (18%), with identical parse output and task data. Parsing
is now bound by fzstd itself: the decompress worker alone takes 5.1-5.3s on that log. Where the
nested worker cannot start, parsing falls back to the previous in-thread decoder. Other codecs and
History Server fetches are unchanged.
