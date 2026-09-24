# sparkforensics-cli

CLI to analyze Apache Spark event logs for performance bottlenecks. Installs
the `sparkforensics-analyze` command.

```bash
npm i -g sparkforensics-cli
sparkforensics-analyze path/to/eventlog --max-runtime 3600000 --max-skew 3
```

Or without installing:
`npx -p sparkforensics-cli sparkforensics-analyze path/to/eventlog`.

See the [main README](https://github.com/shuffle-works/sparkforensics#readme)
for the full flag reference.
