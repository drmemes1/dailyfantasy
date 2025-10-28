import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

async function runAgent(agent_id: string, payload: any) {
  const base = process.env.SWARMNODE_BASE || 'https://api.swarmnode.ai';
  const key = process.env.SWARMNODE_API_KEY || 'cba7a043f91c4613b967e77ca0dd123c'; // your key

  const res = await fetch(`${base}/v1/agent-executor-jobs/create/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ agent_id, payload }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create job failed (${res.status}): ${text}`);
  }

  return await res.json();
}

async function waitForExecution(id: string, maxWaitMs = 60000) {
  const base = process.env.SWARMNODE_BASE || 'https://api.swarmnode.ai';
  const key = process.env.SWARMNODE_API_KEY || 'cba7a043f91c4613b967e77ca0dd123c';

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${base}/v1/executions/${id}/`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json();
    if (data?.status === 'succeeded') return data;
    if (data?.status === 'failed') throw new Error(`Execution failed: ${data?.error}`);
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error('Timeout waiting for execution');
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File;
    const sport = (form.get('sport') as string) || 'NBA';
    const site = (form.get('site') as string) || 'DK';

    if (!file) return NextResponse.json({ ok: false, error: 'Missing file' });

    const buf = Buffer.from(await file.arrayBuffer());
    const csv_text = buf.toString('utf8');
    const date = new Date().toISOString().slice(0, 10);

    const basePayload = {
      slate: { sport, site, date, csv_text },
      options: {
        n_lineups: 20,
        salary_cap: 50000,
        min_players: 8,
        projection_source: 'consensus',
        include_injuries: true,
        format: 'classic',
        version: 'v1',
      },
    };

    const ingestAgent = process.env.AGENT_CSV_INGEST || 'a90dab8f-c720-4658-8a29-8fd2ca4f91cb';
    const projectionAgent = process.env.AGENT_PROJECTIONS || '7072b740-e2d1-4fe6-a34c-b53bc05df514';
    const optimizerAgent = process.env.AGENT_OPTIMIZER || 'e7999e1c-c13a-4ace-9bef-db5d3e532710';

    const j1 = await runAgent(ingestAgent, basePayload);
    const exec1 = await waitForExecution(j1.id);

    const j2 = await runAgent(projectionAgent, basePayload);
    const exec2 = await waitForExecution(j2.id);

    const j3 = await runAgent(optimizerAgent, basePayload);
    const exec3 = await waitForExecution(j3.id);

    return NextResponse.json({
      ok: true,
      ingest: j1,
      projections: j2,
      optimizer: j3,
      exec: { ingest: exec1, projections: exec2, optimizer: exec3 },
    });
  } catch (e: any) {
    console.error('Error running pipeline:', e);
    return NextResponse.json({ ok: false, error: e.message || String(e) });
  }
}

