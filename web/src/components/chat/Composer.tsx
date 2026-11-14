import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { toast } from "sonner";
import type { Part } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { AttachmentChip } from "./Parts";

export interface Attachment {
  key: string;
  name: string;
  mime: string;
  part?: Part;
  uploading?: boolean;
}

/** Turns a picked file into a message part (inline base64 / text, or an S3 upload → fileId). */
export type AttachFn = (file: File, onProgress?: (fraction: number) => void) => Promise<Part>;

export function Composer(props: {
  disabled?: boolean;
  running?: boolean;
  onSend(parts: Part[]): void;
  onStop(): void;
  attach: AttachFn;
  placeholder?: string;
  initialText?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(props.initialText ?? "");
  const [atts, setAtts] = useState<Attachment[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const mime = file.type || "application/octet-stream";
      setAtts((a) => [...a, { key, name: file.name || "貼上的圖片", mime, uploading: true }]);
      try {
        const part = await props.attach(file);
        setAtts((a) => a.map((x) => (x.key === key ? { ...x, part, uploading: false } : x)));
      } catch (e) {
        toast.error(`${file.name}：${(e as Error).message}`);
        setAtts((a) => a.filter((x) => x.key !== key));
      }
    }
  }

  const uploading = atts.some((a) => a.uploading);
  const canSend = !props.disabled && !props.running && !uploading && (text.trim().length > 0 || atts.some((a) => a.part));

  function send() {
    if (!canSend) return;
    const parts: Part[] = [];
    if (text.trim()) parts.push({ type: "text", text });
    for (const a of atts) if (a.part) parts.push(a.part);
    props.onSend(parts);
    setText("");
    setAtts([]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function onDrop(e: DragEvent) {
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  }

  return (
    <div className="rounded-xl border bg-card shadow-sm focus-within:ring-1 focus-within:ring-ring" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {atts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {atts.map((a) => (
            <AttachmentChip key={a.key} name={a.name} mime={a.mime} uploading={a.uploading} onRemove={() => setAtts((x) => x.filter((y) => y.key !== a.key))} />
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={text}
        autoFocus={props.autoFocus}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder={props.placeholder ?? "輸入訊息…（Enter 送出，Shift+Enter 換行）"}
        className="block max-h-72 w-full resize-none bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center justify-between px-2 pb-2">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
        <Button variant="ghost" size="icon" title="附加檔案或圖片" aria-label="附加檔案" onClick={() => fileInput.current?.click()} disabled={props.disabled}>
          <Paperclip />
        </Button>
        {props.running ? (
          <Button size="icon" variant="secondary" title="停止" aria-label="停止" onClick={props.onStop}><Square className="fill-current" /></Button>
        ) : (
          <Button size="icon" title="送出" aria-label="送出" disabled={!canSend} onClick={send}><ArrowUp /></Button>
        )}
      </div>
    </div>
  );
}

// ---------- inline attachment helpers (no S3 needed) ----------

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|sql|ini|cfg|conf|log|env|vue|svelte|tex|r|lua|dart|scala|ex|exs|clj|hs|ml|pl|graphql|proto)$/i;

export function isTextFile(f: File) {
  return f.type.startsWith("text/") || /json|xml|yaml|javascript|typescript|sql|csv|x-sh/.test(f.type) || TEXT_EXT.test(f.name);
}

export function fileToBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("讀取檔案失敗"));
    r.readAsDataURL(f);
  });
}
