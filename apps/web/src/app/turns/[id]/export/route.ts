import { NextResponse } from 'next/server';
import { getFileChanges, getToolCalls, getTurn } from '@/lib/queries';

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

  const [toolCalls, fileChanges] = await Promise.all([getToolCalls(id), getFileChanges(id)]);

  const body = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      note: 'Local export from the AI usage observability dashboard. Costs are list-price estimates, not billing records.',
      turn,
      tool_calls: toolCalls,
      file_changes: fileChanges,
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
