import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export interface ExpandConfirmDialogProps {
  open: boolean;
  nodeCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ExpandConfirmDialog({ open, nodeCount, onConfirm, onCancel }: ExpandConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Expand to full plan?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This plan has {nodeCount} nodes. Rendering the full graph may take several seconds.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button type="button" size="sm" onClick={onConfirm}>Expand anyway</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
