import { NextResponse } from 'next/server';
import { parsePrompt } from '@/lib/attachments';
import { getFileChanges, getPromptMedia, getToolCalls, getTurn } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * One turn, as stored.
 *
 * The point of the export is to take a turn somewhere else — a bug report, a
 * spreadsheet, a diff of two runs — so it carries the provenance columns
 * (`token_source`, `provider_source`, `cost_source`, `attribution`,
 * `duration_source`) rather than just the numbers. A cost without its source
 * is not a fact anyone can check.
 *
 * Diff bodies ARE included here, unlike anywhere else that touches
 * file_changes, because this is one turn fetched deliberately rather than a
 * list dragging TOASTed values it will not render.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const turn = await getTurn(id);
  if (!turn) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const [toolCalls, fileChanges, media] = await Promise.all([
    getToolCalls(id),
    getFileChanges(id),
    getPromptMedia(id),
  ]);

  const body = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      note: 'Local export from the AI usage observability dashboard. Costs are list-price estimates, not billing records.',
      turn,
      tool_calls: toolCalls,
      file_changes: fileChanges,
      // What the user sent with the prompt. The editor context and the
      // @mentions are derived from `turn.prompt_text`, which is in this file
      // already; screenshots and documents are not, so each carries the path
      // that serves its bytes rather than the bytes themselves — a single
      // attachment in this archive is 4.9 MB, and an export is meant to be
      // readable.
      prompt_attachments: parsePrompt(turn.prompt_text).attachments,
      prompt_media: media.map((m) => ({ ...m, href: `/turns/${id}/attachment/${m.idx}` })),
    },
    null,
    2,
  );

  const name = `turn-${turn.external_session_id.slice(0, 8)}-${turn.seq}.json`;
  return new NextResponse(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
    },
  });
}
