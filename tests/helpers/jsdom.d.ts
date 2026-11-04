// jsdom ships no types and @types/jsdom is not a dependency; this declares the part the tests use.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { contentType?: string });
    readonly window: Window & typeof globalThis;
  }
}
