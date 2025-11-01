'use client';
import React, { useState } from 'react';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [sport, setSport] = useState('NBA');
  const [site, setSite]   = useState('DK');
  const [resp, setResp]   = useState<any>(null);
  const [busy, setBusy]   = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { alert('Choose a CSV first'); return; }
    const form = new FormData();
    form.append('file', file); // key MUST be "file"
    form.append('sport', sport);
    form.append('site', site);
    setBusy(true);
    try {
      const r = await fetch('/api/submit', { method: 'POST', body: form });
      const j = await r.json();
      setResp(j);
    } catch (err:any) {
      setResp({ ok:false, error: err?.message || String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{padding:'24px', maxWidth: 900, margin:'0 auto'}}>
      <h1 style={{fontSize: 24, fontWeight: 600, marginBottom: 16}}>Daily Fantasy CSV → Optimized Lineup</h1>
      <form onSubmit={onSubmit} style={{display:'grid', gap: 12}}>
        <input type="file" accept=".csv,text/csv" onChange={e=>setFile(e.target.files?.[0] || null)} />
        <div style={{display:'flex', gap: 8}}>
          <select value={sport} onChange={e=>setSport(e.target.value)}>
            <option>NBA</option>
          </select>
          <select value={site} onChange={e=>setSite(e.target.value)}>
            <option>DK</option>
          </select>
        </div>
        <button type="submit" disabled={busy || !file} style={{padding:'8px 14px', background:'#000', color:'#fff', borderRadius:6, opacity: busy||!file ? 0.6 : 1}}>
          {busy ? 'Submitting…' : 'Submit'}
        </button>
      </form>
      <pre style={{marginTop: 24, padding: 16, background:'#f5f5f5', overflowX:'auto', fontSize: 12}}>
        {resp ? JSON.stringify(resp, null, 2) : 'Awaiting upload…'}
      </pre>
    </main>
  );
}

