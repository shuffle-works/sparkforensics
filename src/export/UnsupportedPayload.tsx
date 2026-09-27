/** What the export bundle shows instead of a dashboard when its payload is a
 * version it was not built for (see `unsupportedPayloadReason`). */
export function UnsupportedPayload({ reason }: { reason: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <section role="alert" className="max-w-prose space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-5">
        <h1 className="font-heading text-lg font-semibold">This dashboard can't be shown</h1>
        <p className="text-sm text-muted-foreground">{reason}</p>
      </section>
    </main>
  );
}
