import { Collapsible } from './Collapsible';
import { ImagePreview } from './ImagePreview';
import { IconFile, IconImage, IconPaperclip, IconSelection } from './icons';
import type { PromptAttachment } from '@/lib/attachments';
import { bytes, tailPath } from '@/lib/format';
import type { PromptMediaRow } from '@/lib/queries';

/**
 * What the user sent with the prompt, beside the prompt.
 *
 * Four kinds, and the distinction between them is the point — they did not
 * reach the model the same way, and only two of them were a deliberate act:
 *
 *   - a screenshot or document, attached by the user;
 *   - an editor selection, with the lines it covered;
 *   - the file that happened to be open in the editor, which Claude Code sends
 *     on its own and the user may never have thought about;
 *   - an `@path` the user typed, which is a request to read a file, not the
 *     file itself — the content is not recorded here, so this says "mentioned".
 *
 * Collapsing them into one undifferentiated "attachments" list would imply the
 * user chose to send all four. They did not.
 */

const CARD = 'rounded-lg border border-line bg-surface-2 p-2.5';

function Label({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="eyebrow flex items-center gap-1.5">
      <span className="text-ink-3">{icon}</span>
      {children}
    </div>
  );
}

/** A host path, tail-first with the whole thing in the title. */
function PathLine({ path }: { path: string }) {
  return (
    <div className="mono mt-1 truncate text-[11px] text-ink" title={path}>
      {tailPath(path, 3)}
    </div>
  );
}

function MediaCard({ turnId, row }: { turnId: string; row: PromptMediaRow }) {
  const src = `/turns/${turnId}/attachment/${row.idx}`;
  const size = row.byte_size === null ? 'size unknown' : bytes(row.byte_size);
  const type = row.media_type ?? 'unknown type';
  const meta = `${type} · ${size}`;

  if (row.source_type !== 'base64') {
    // The block referenced its content rather than carrying it, so nothing was
    // recorded. Say that, rather than offering a preview that cannot load.
    return (
      <div className={CARD}>
        <Label icon={<IconPaperclip className="h-3.5 w-3.5" />}>{row.block_type}</Label>
        <p className="mt-1 text-[11px] text-warn">
          Recorded as a reference ({row.source_type ?? 'no source type'}), not as content — the
          bytes were never captured.
        </p>
      </div>
    );
  }

  if (row.block_type === 'image') {
    return <ImagePreview src={src} label={`Screenshot ${row.idx}`} meta={meta} />;
  }

  return (
    <a href={src} target="_blank" rel="noreferrer" className={`${CARD} block hover:border-accent`}>
      <Label icon={<IconFile className="h-3.5 w-3.5" />}>document</Label>
      <div className="mono mt-1 truncate text-[11px] text-ink">{meta}</div>
      <div className="mt-1 text-[11px] text-accent">Open →</div>
    </a>
  );
}

function SelectionCard({ a }: { a: Extract<PromptAttachment, { kind: 'selection' }> }) {
  const span = a.fromLine === a.toLine ? `line ${a.fromLine}` : `lines ${a.fromLine}–${a.toLine}`;
  const lines = a.snippet === '' ? 0 : a.snippet.split('\n').length;
  const body = (
    <pre className="mono mt-2 overflow-x-auto rounded-md border border-line bg-surface p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
      {a.snippet === '' ? '(the block recorded no selected text)' : a.snippet}
    </pre>
  );

  return (
    <div className={CARD}>
      <Label icon={<IconSelection className="h-3.5 w-3.5" />}>editor selection · {span}</Label>
      <PathLine path={a.path} />
      {/* A selection can be a whole method — 40+ lines here at the longest. */}
      {lines > 8 ? (
        <Collapsible maxHeight={150} showLabel={`Show all ${lines} lines`} hideLabel="Collapse">
          {body}
        </Collapsible>
      ) : (
        body
      )}
    </div>
  );
}

export function PromptAttachments({
  turnId,
  attachments,
  media,
}: {
  turnId: string;
  attachments: PromptAttachment[];
  media: PromptMediaRow[];
}) {
  const selections = attachments.filter((a) => a.kind === 'selection');
  const openFiles = attachments.filter((a) => a.kind === 'open_file');
  const mentions = attachments.filter((a) => a.kind === 'mention');
  const total = media.length + attachments.length;
  if (total === 0) return null;

  const images = media.filter((m) => m.block_type === 'image').length;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="eyebrow flex items-center gap-1.5">
          <IconPaperclip className="h-3.5 w-3.5 text-ink-3" />
          Sent with this prompt
        </h3>
        <span className="mono ml-auto text-[11px] text-ink-3">{total}</span>
      </div>

      {images > 0 && (
        <Label icon={<IconImage className="h-3.5 w-3.5" />}>
          screenshot{images === 1 ? '' : 's'} · {images}
        </Label>
      )}
      {media.map((row) => (
        <MediaCard key={row.idx} turnId={turnId} row={row} />
      ))}

      {selections.map((a, i) => (
        <SelectionCard key={`sel-${i}`} a={a} />
      ))}

      {openFiles.map((a, i) => (
        <div key={`open-${i}`} className={CARD}>
          <Label icon={<IconFile className="h-3.5 w-3.5" />}>open in editor</Label>
          <PathLine path={a.path} />
          <p className="mt-1.5 text-[11px] text-ink-3">
            Sent by the editor, not chosen by the user — it was in focus when the prompt was
            typed.
          </p>
        </div>
      ))}

      {mentions.length > 0 && (
        <div className={CARD}>
          <Label icon={<IconFile className="h-3.5 w-3.5" />}>
            mentioned · {mentions.length}
          </Label>
          <ul className="mt-1 space-y-0.5">
            {mentions.map((a, i) => (
              <li key={`men-${i}`} className="mono truncate text-[11px] text-ink" title={a.path}>
                @{tailPath(a.path, 2)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-3">
            Typed as an @path in the prompt. The file&apos;s contents are not recorded with the
            turn — what the agent then read shows up under Commands.
          </p>
        </div>
      )}
    </div>
  );
}
