import { z } from 'zod';

// Proxy-level error envelope: the JSON body the local server's SHS proxy
// (./shs-request.js) sends back on a non-OK upstream response, e.g.
// `{ code: 'shs-unreachable' }`. This is NOT a SparkListener* event shape, so
// it lives here rather than in event-schemas.ts. `.passthrough()` since the
// proxy may attach extra debugging fields the consumer doesn't care about;
// only `code` is read.
export const ShsProxyErrorBodySchema = z.object({
  code: z.string(),
}).passthrough();

export type ShsProxyErrorBody = z.infer<typeof ShsProxyErrorBodySchema>;
