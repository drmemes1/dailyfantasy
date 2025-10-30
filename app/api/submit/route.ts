import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// --- HARD-CODED (rotate before pushing public) ---
const SWARMNODE_BASE = 'https://api.swarmnode.ai';
const SWARMNODE_API_KEY = 'cba7a043f91c4613b967e77ca0dd123c';

const AGENT_IDS = {
  INGEST:     'a2a2fc57-1b93-41a1-a1dd-0035e5289280',
  SIGNALS:    'ca72bbfe-37c3-47b3-ada7-6e39f474eed4',
  PROJECTIONS:'e8712c1e-5636-434c-9793-5ee85123025a',
  CONSENSUS:  'c1b8ab28-5d1c-4609-b815-03dcb322e186',
  OPTIMIZER:  'd154cbc3-ff61-4c87-b61c-2a75bce90146',
};

// ---------- helpers ----------
async function createJob(agent_id: string, payload: any) {
  const res = await fetch(`${SWARMNODE_BASE}/v1/agent-executor-jobs/create/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SWARMNODE_API_KEY}`, 'content-type': 'application/json', accept:'application/json' },
    body: JSON.stringify({ agent_id, payload }),
    cache: 'no-store',
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Create job failed (${res.status}) for ${agent_id}: ${txt || 'no body'}`);
  try { return JSON.parse(txt); } catch { throw new Error(`Create job bad JSON: ${txt}`); }
}

async function getExec(id: string) {
  for (const url of [
    `${SWARMNODE_BASE}/v1/executions/${id}/`,
    `${SWARMNODE_BASE}/v1/executions/${id}`,
  ]) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${SWARMNODE_API_KEY}` }, cache: 'no-store' });
    const txt = await res.text();
    if (res.ok) { try { return JSON.parse(txt); } catch { throw new Error(`Bad JSON from ${url}: ${txt}`); } }
    if (res.status !== 404) throw new Error(`Execution ${id} failed (${res.status}): ${txt || 'no body'}`);
  }
  const e: any = new Error('not-ready'); e.__retry = true; throw e;
}

async function waitExec(id: string, timeoutMs = 120000, pollMs = 1500) {
  const start = Date.now();
  while (true) {
    try {
      const ex = await getExec(id);
      const s = (ex.status || ex.state || '').toLowerCase();
      if (s && !['queued','pending','running','in_progress'].includes(s)) return ex;
    } catch (e:any) { if (!e?.__retry) throw e; }
    if (Date.now() - start > timeoutMs) return { timeout:true, id };
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ---------- POST ----------
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const sport = (form.get('sport') as string) || 'NBA';
    const site  = (form.get('site') as string)  || 'DK';
    if (!file) return NextResponse.json({ ok:false, error:'Missing file' }, { status: 400 });

    const buf = Buffer.from(await file.arrayBuffer());
    const csv_text = buf.toString('utf8');
    const date = new Date().toISOString().slice(0,10);

    const basePayload = {
      slate: { sport, site, date, csv_text },
      options: { n_lineups: 20, salary_cap: 50000, min_players: 8, include_injuries: true, format: 'classic', version: 'v1' }
    };

    // 1) INGEST
    const jIngest = await createJob(AGENT_IDS.INGEST, basePayload);
    const eIngest = await waitExec(jIngest.execution_address);
    const ingestedPlayers =
      eIngest?.result?.players ||
      eIngest?.result?.output?.players ||
      eIngest?.players || null;

    // 2) SIGNALS (pass ingested players)
    const jSig = await createJob(AGENT_IDS.SIGNALS, { ...basePayload, players: ingestedPlayers || [] });
    const eSig = await waitExec(jSig.execution_address);
    const signals = eSig?.result || eSig || {};

    // 3) PROJECTIONS x2 (Claude + ChatGPT) with signals injected
    const llms = [
      { provider: 'anthropic', model: 'claude-3-5-sonnet', temperature: 0.2 },
      { provider: 'openai',    model: 'gpt-4o-mini',       temperature: 0.2 },
    ];
    const projPayload = (llm:any)=>({
      ...basePayload,
      ...(ingestedPlayers ? { players: ingestedPlayers } : {}),
      ...signals,
      options: { ...basePayload.options, llm },
    });

    const projJobs = await Promise.all(llms.map(llm => createJob(AGENT_IDS.PROJECTIONS, projPayload(llm))));
    const projExecs = await Promise.all(projJobs.map(j => waitExec(j.execution_address)));
    const projection_sets = projExecs.map(ex => {
      const data = ex?.result?.output || ex?.result || ex?.data || ex;
      return data?.players ? { players: data.players } : data;
    });

    // 4) CONSENSUS
    const jCons = await createJob(AGENT_IDS.CONSENSUS, { slate: basePayload.slate, method: 'avg', projection_sets });
    const eCons = await waitExec(jCons.execution_address);
    const consensus = eCons?.result?.consensus || eCons?.result || eCons;

    // 5) OPTIMIZER
    const jOpt = await createJob(AGENT_IDS.OPTIMIZER, { ...basePayload, consensus });
    const eOpt = await waitExec(jOpt.execution_address);
    const lineups = eOpt?.result?.lineups || eOpt?.lineups || null;

    return NextResponse.json({
      ok: true,
      lineups,
      debug: {
        ingest_exec: jIngest?.execution_address,
        signals_exec: jSig?.execution_address,
        proj_execs: projJobs.map(j => j.execution_address),
        cons_exec: jCons?.execution_address,
        opt_exec: jOpt?.execution_address,
      }
    });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e?.message || String(e) }, { status: 500 });
  }
}

