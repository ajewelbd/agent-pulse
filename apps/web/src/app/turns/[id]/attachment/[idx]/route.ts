import { NextResponse } from 'next/server';
import { getPromptMediaBlock } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * One screenshot or document the user attached to a prompt.
 *
 * It exists as a route rather than a data: URI on the page because these are
 * large — up to 4.9 MB for a single attachment in this archive — and a page
 * that inlined them would pay for every attachment on every load, whether or
 * not anyone opened one. As a route the browser caches each one and fetches it
 * only when its thumbnail renders.
 *
 * SECURITY: the media type is the agent's string, from the transcript, and it
 * is NOT echoed into the response. A stored `text/html` served from this
 * origin would be a stored-XSS vector against the dashboard, so the type is
 * mapped through an allowlist and anything unrecognised is served as an opaque
 * download. `nosniff` stops the browser second-guessing that.
 */
const SERVABLE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; idx: string }> },
) {
  const { id, idx } = await params;
  if (!/^\d+$/.test(id) || !/^\d+$/.test(idx)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const block = await getPromptMediaBlock(id, Number(idx));
  if (!block) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (block.source_type !== 'base64' || block.data === null) {
    // A block that references its content instead of carrying it. Nothing was
    // recorded, so there is nothing to serve — and a 0-byte body would read as
    // an empty image rather than as an absent one.
    return NextResponse.json(
      { error: 'this attachment carries no inline data', source_type: block.source_type },
      { status: 404 },
    );
  }

  const ext = block.media_type === null ? undefined : SERVABLE[block.media_type];
  const bytes = Buffer.from(block.data, 'base64');
  const name = `turn-${id}-attachment-${idx}.${ext ?? 'bin'}`;

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'content-type': ext ? block.media_type! : 'application/octet-stream',
      'content-length': String(bytes.length),
      'content-disposition': `${ext ? 'inline' : 'attachment'}; filename="${name}"`,
      'x-content-type-options': 'nosniff',
      // Immutable: an attachment is a record of what was sent, and nothing in
      // this system rewrites one. Private, because it is one prompt's content.
      'cache-control': 'private, max-age=3600, immutable',
    },
  });
}
