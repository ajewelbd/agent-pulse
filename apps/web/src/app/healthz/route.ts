import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Container healthcheck.
 *
 * Deliberately touches the database. A dashboard process that is listening but
 * cannot reach Postgres is not healthy in any useful sense — it would serve
 * nothing but 500s while compose reported it green. `SELECT 1` is cheap enough
 * to poll on a 10s interval, unlike rendering the turn list.
 */
export async function GET(): Promise<Response> {
  try {
    await queryOne('SELECT 1 AS ok');
    return Response.json({ ok: true }, { status: 200 });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
