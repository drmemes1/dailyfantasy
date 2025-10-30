import { NextResponse } from 'next/server';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get('file') as File | null;

  if (!file) {
    return NextResponse.json({ ok: false, error: 'No file' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const csv_text = buf.toString('utf8');

  return NextResponse.json({
    ok: true,
    bytes: buf.length,
    preview: csv_text.slice(0, 200), // first 200 chars so you can confirm headers
  });
}

