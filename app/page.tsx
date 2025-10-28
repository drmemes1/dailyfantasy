'use client';
import { useState } from 'react';

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string>('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('sport', 'NBA');
    form.append('site', 'DK');
    const res = await fetch('/api/submit', { method: 'POST', body: form });
    const j = await res.json();
    setMsg(JSON.stringify(j, null, 2));
  }

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: '0 auto', fontFamily: 'ui-sans-serif,system-ui' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600 }}>Upload DK Salaries CSV → Build Lineup</h1>
      <form onSubmit={onSubmit} style={{ marginTop: 16, display: 'grid', gap: 12 }}>
        <input type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files?.[0] || null)} />
        <button disabled={!file} style={{ padding: '10px 16px', borderRadius: 8, background: '#111', color: '#fff' }}>
          Submit
        </button>
      </form>
      {msg && (
        <pre style={{ background: '#f7f7f8', padding: 12, borderRadius: 8, marginTop: 16, fontSize: 12 }}>
{msg}
        </pre>
      )}
    </main>
  );
}

