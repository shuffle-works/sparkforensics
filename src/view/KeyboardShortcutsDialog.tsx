import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import packageJson from '../../package.json';

/** One visual keycap. Multiple `keys` render as alternatives ("Enter or
 * Space"), not a chord: this app has no multi-key chords to document. */
function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, i) => (
        <span key={key} className="flex items-center gap-1">
          {i > 0 ? <span className="text-xs text-muted-foreground">or</span> : null}
          <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

function Row({ keys, children }: { keys: string[]; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-foreground">{children}</span>
      <Keys keys={keys} />
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <div className="divide-y divide-border/60">{children}</div>
    </div>
  );
}

/** Documents only keyboard interactions that already work today, sourced
 * from a full code audit rather than aspirational shortcuts: Escape's
 * route/dialog-closing, Base UI's built-in dialog and menu keyboard model,
 * the Type/Stage filter search boxes, the sortable StageTable headers, and
 * the Stage-ID buttons that open a stage's detail dialog. Nothing here is a
 * new keybinding except this dialog's own "?" trigger, wired in Topbar.tsx. */
export function KeyboardShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Everything below works from anywhere the board is loaded.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Group title="Navigation">
            <Row keys={['Tab', 'Shift+Tab']}>Move between controls</Row>
            <Row keys={['Enter', 'Space']}>Activate the focused control, open a stage's details, or sort a column</Row>
            <Row keys={['Esc']}>Close the open dialog, or leave a full-page view like Plan graph</Row>
          </Group>
          <Group title="Menus and lists">
            <Row keys={['↑', '↓']}>Move between menu items or picker rows</Row>
            <Row keys={['A–Z', '0–9']}>Filter the Type and Stage dropdowns, and the plan execution picker, as you type</Row>
          </Group>
          <Group title="Help">
            <Row keys={['?']}>Open this list</Row>
          </Group>
        </div>
        <p className="text-center text-xs text-muted-foreground">SparkForensics v{packageJson.version}</p>
      </DialogContent>
    </Dialog>
  );
}
