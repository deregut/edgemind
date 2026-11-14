import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** Small text-input dialog (rename, new project …). */
export function PromptDialog(props: {
  open: boolean;
  onOpenChange(v: boolean): void;
  title: string;
  description?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit(value: string): Promise<void> | void;
}) {
  const [value, setValue] = useState(props.initial ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open) setValue(props.initial ?? "");
  }, [props.open, props.initial]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    try {
      await props.onSubmit(value.trim());
      props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            {props.description && <DialogDescription>{props.description}</DialogDescription>}
          </DialogHeader>
          <Input autoFocus value={value} placeholder={props.placeholder} onChange={(e) => setValue(e.target.value)} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={busy || !value.trim()}>{props.confirmLabel ?? "確定"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog(props: { open: boolean; onOpenChange(v: boolean): void; title: string; description?: ReactNode; confirmLabel?: string; destructive?: boolean; onConfirm(): Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>取消</Button>
          <Button
            variant={props.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await props.onConfirm();
                props.onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {props.confirmLabel ?? "確定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
