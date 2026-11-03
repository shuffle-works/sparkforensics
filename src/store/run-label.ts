// recent-files ids are `${name}::${size}::${lastModified}`: show just the name. Preferred over
// app.name, which is usually identical across the two compared runs.
export function runLabel(id: string): string {
  return id.split('::')[0] || id;
}
