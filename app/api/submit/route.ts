import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300; // up to ~5 minutes for the edge; we also poll up to 10 mins total

// ---- ENV / IDs ----
const BASE = (process.env.SWARMNODE_BASE || 'https://api.swarmnode.ai').trim();
const KEY  = (process.env.SWARMNODE_API_KEY || '').trim();

const AGENTS = {
  INGEST:      (process.env.AGENT_CSV_INGEST    || '').trim(),
  PROJECTIONS: (process.env.AGENT_PROJECTIONS   || '').trim(),
  CONSENSUS:   (process.env.AGENT_CONSENSUS     || '').trim(),
  OPTIMIZER:   (process.env.AGENT_OPTIMIZER     || '').trim(),
  SIGNALS:     (process.env.AGENT_SIGNALS       || '').trim(), // optional
};

// ---- Small helpers ----
function jerr(msg: string, extra: any = {}, status = 500) {
  console.error('[submit:error]', msg, extra);
  return NextResponse.json({ ok: false, error: msg, extra }, { status });
}

function assertEnv() {
  if (!KEY) throw new Error('Missing SWARMNODE_API_KEY');
  if (!AGENTS.INGEST || !AGENTS.PROJECTIONS || !AGENTS.CONSENSUS || !AGENTS.OPTIMIZER) {
    throw new Error('Missing one or more required agent IDs (INGEST/PROJECTIONS/CONSENSUS/OPTIMIZER)');
  }
}

// Try both endpoints (some tenants use /create/, some accept root POST)
async function createJob(agent_id: string, payload: any, label: string) {
  const endpoints = [
    `${BASE}/v1/agent-executor-jobs/create/`,
    `${BASE}/v1/agent-executor-jobs/`,
  ];

  const errors: Array<{ url: string; status?: number; text?: string }> = [];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${KEY}`,      // CRITICAL: exact header + trimmed key
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ agent_id, payload }),
        cache: 'no-store',
      });
      const txt = await res.text();
      if (!res.ok) {
        errors.push({ url, status: res.status, text: txt });
        continue;
      }
      const parsed = JSON.parse(txt || '{}');
      if (parsed?.execution_address) return parsed;
      errors.push({ url, status: res.status, text: 'No execution_address in response' });
    } catch (e: any) {
      errors.push({ url, text: e?.message || String(e) });
    }
  }
  throw new Error(`Create job failed for ${label}/${agent_id}: ${JSON.stringify(errors)}`);
}

async function getExec(executionId: string) {
  const urls = [
    `${BASE}/v1/executions/${executionId}/`,
    `${BASE}/v1/executions/${executionId}`,
  ];
  for (const url of urls) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` },
      cache: 'no-store',
    });
    const txt = await res.text();
    if (res.ok) return JSON.parse(txt || '{}');
    // 404 means not ready yet — keep polling; other codes bubble up
    if (res.status !== 404) throw new Error(`Get execution failed (${res.status}): ${txt || 'no body'}`);
  }
  const err: any = new Error('not-ready');
  err.__retry = true;
  throw err;
}

// Treat as done if status is terminal OR there is a result/known payload present
function isDone(ex: any) {
  const s = (ex?.status || ex?.state || '').toString().toLowerCase();
  if (s && !['queued', 'pending', 'running', 'in_progress'].includes(s)) return true;
  if (ex?.result) return true;
  if (ex?.players || ex?.lineups || ex?.consensus || ex?.output) return true;
  return false;
}

// Poll up to 10 minutes
async function waitExec(executionId: string, label: string, timeoutMs = 600_000, pollMs = 2_000) {
  const t0 = Date.now();
  while (true) {
    try {
      const ex = await getExec(executionId);
      if (isDone(ex)) return ex;
    } catch (e: any) {
      if (!e?.__retry) throw new Error(`${label} poll failed: ${e?.message || String(e)}`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ---- Local CSV fallback (fast, capped) ----
function localCsvToPlayers(csvText: string, minSalary = 3500, maxPlayers = 120) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const hdr = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = (key: string) => hdr.indexOf(key);

  const iName = idx('name');
  const iPos1 = idx('position');
  const iPos2 = idx('positions');
  const iSal  = idx('salary');
  const iTeam = ['teamabbrev', 'team', 'team_abbrev', 'teamabbr']
    .map(idx)
    .find(i => i >= 0) ?? -1;

  if (iName < 0 || iSal < 0) return [];

  const out: any[] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(',');
    const name = (cells[iName] || '').trim();
    if (!name) continue;
    const posRaw = iPos1 >= 0 ? cells[iPos1] : (iPos2 >= 0 ? cells[iPos2] : '');
    const positions = (posRaw || '')
      .replace('/', ',')
      .split(',')
      .map(p => p.trim().toUpperCase())
      .filter(Boolean);
    const salary = parseFloat((cells[iSal] || '').replace('$', '')) || 0;
    const team = iTeam >= 0 ? (cells[iTeam] || '').trim().toUpperCase() : '';
    if (salary < minSalary) continue;
    out.push({
      name,
      player_id: name,
      positions: positions.length ? positions : ['UTIL'],
      salary,
      team,
    });
  }
  out.sort((a, b) => (b.salary - a.salary) || a.name.localeCompare(b.name));
  return out.slice(0, Math.max(0, maxPlayers));
}

// ---- Route handler ----
export async function POST(req: Request) {
  try {
    assertEnv();

    const form = await req.formData();
    const file = form.get('file') as File | null;
    if (!file) return jerr('Missing file', {}, 400);

    const sport = (form.get('sport') as string) || 'NBA';
    const site  = (form.get('site')  as string) || 'DK';

    const buf = Buffer.from(await file.arrayBuffer());
    const csv_text = buf.toString('utf8');
    if (!csv_text.trim()) return jerr('Uploaded CSV empty', {}, 400);

    const date = new Date().toISOString().slice(0, 10);

    // shared options (you can tweak caps here)
    const basePayload = {
      slate: { sport, site, date, csv_text },
      options: {
        n_lineups: 20,
        salary_cap: 50000,
        min_players: 8,
        include_injuries: true,
        format: 'classic',
        version: 'v1',
        // Ingest caps:
        min_salary: 3500,
        max_players: 120,
        keep_starters: true,
      },
    };

    // 1) INGEST (Swarm) with local fallback
    let ingestedPlayers: any[] | null = null;
    let ingestExecId: string | null = null;

    try {
      const jIngest = await createJob(AGENTS.INGEST, basePayload, 'INGEST');
      ingestExecId = jIngest.execution_address;
      const eIngest = await waitExec(ingestExecId, 'INGEST');
      const raw = eIngest?.result || eIngest || {};
      ingestedPlayers =
        raw?.players || raw?.output?.players || raw?.data?.players || null;

      if (!Array.isArray(ingestedPlayers) || ingestedPlayers.length === 0) {
        const errMsg = raw?.error || raw?.message || raw?.detail || null;
        if (errMsg) throw new Error(`Ingest error: ${errMsg}`);
        ingestedPlayers = null; // fall back below
      }
    } catch (e: any) {
      console.warn('[submit] INGEST via Swarm failed, will try local CSV fallback:', e?.message || String(e));
      ingestedPlayers = null;
    }

    if (!ingestedPlayers) {
      const local = localCsvToPlayers(csv_text, 3500, 120);
      if (local.length === 0) return jerr('Ingest failed and local CSV parse found 0 players', {}, 400);
      ingestedPlayers = local;
    }

    // 2) SIGNALS (optional but recommended)
    let signals: any = {};
    if (AGENTS.SIGNALS) {
      const jSig = await createJob(
        AGENTS.SIGNALS,
        { ...basePayload, players: ingestedPlayers },
        'SIGNALS'
      );
      const eSig = await waitExec(jSig.execution_address, 'SIGNALS');
      signals = eSig?.result || eSig || {};
    }

    // 3) PROJECTIONS (run twice: Claude + GPT)
    const llms = [
      { provider: 'anthropic', model: 'claude-3-5-sonnet', temperature: 0.2 },
      { provider: 'openai',    model: 'gpt-4o-mini',       temperature: 0.2 },
    ];
    const projPayload = (llm: any) => ({
      ...basePayload,
      players: ingestedPlayers,
      ...signals, // inject signals bundle
      options: { ...basePayload.options, llm },
    });

    const pJobs = await Promise.all(
      llms.map((llm) => createJob(AGENTS.PROJECTIONS, projPayload(llm), 'PROJECTIONS'))
    );
    const pExecs = await Promise.all(
      pJobs.map((j) => waitExec(j.execution_address, 'PROJECTIONS'))
    );
    const projection_sets = pExecs.map((ex) => {
      const data = ex?.result?.output || ex?.result || ex?.data || ex;
      return data?.players ? { players: data.players } : data;
    });

    // 4) CONSENSUS
    const jCons = await createJob(
      AGENTS.CONSENSUS,
      { slate: basePayload.slate, method: 'avg', projection_sets },
      'CONSENSUS'
    );
    const eCons = await waitExec(jCons.execution_address, 'CONSENSUS');
    const consensus = eCons?.result?.consensus || eCons?.result || eCons;

    // 5) OPTIMIZER
    const jOpt = await createJob(
      AGENTS.OPTIMIZER,
      { ...basePayload, consensus },
      'OPTIMIZER'
    );
    const eOpt = await waitExec(jOpt.execution_address, 'OPTIMIZER');
    const lineups = eOpt?.result?.lineups || eOpt?.lineups || null;

    return NextResponse.json({
      ok: true,
      lineups,
      debug: {
        ingest_exec: ingestExecId,
        proj_execs: pJobs.map((j) => j.execution_address),
        cons_exec: jCons?.execution_address,
        opt_exec: jOpt?.execution_address,
        signals_used: !!AGENTS.SIGNALS,
      },
    });
  } catch (e: any) {
    return jerr(e?.message || String(e));
  }
}

