// markdown-it-footnote ships no types; this declares the plugin as a markdown-it plugin.
declare module 'markdown-it-footnote' {
  import type MarkdownIt from 'markdown-it';
  const footnote: MarkdownIt.PluginSimple;
  export default footnote;
}
