# sparkforensics

Installs the `sparkforensics-analyze` command, which analyzes Apache Spark
event logs for performance bottlenecks. This package holds no analysis code:
it depends on [sparkforensics-cli](https://www.npmjs.com/package/sparkforensics-cli)
and runs its `sparkforensics-analyze` bin with the same arguments, output and
exit code.

```bash
npm install -g sparkforensics
sparkforensics-analyze path/to/eventlog --max-runtime 3600000 --max-skew 3
```

Or without installing: `npx sparkforensics path/to/eventlog`.

See the [main README](https://github.com/shuffle-works/sparkforensics#readme)
for the full flag reference and exit codes.
