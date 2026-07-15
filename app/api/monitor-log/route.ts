import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const monitorLogPath = path.join(process.cwd(), 'monitor-log.json');

export async function GET() {
  try {
    const log = fs.existsSync(monitorLogPath)
      ? JSON.parse(fs.readFileSync(monitorLogPath, 'utf8'))
      : [];
    return NextResponse.json({ log });
  } catch (error) {
    console.error('Error GET /api/monitor-log:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const logId = searchParams.get('logId');

    const log: any[] = fs.existsSync(monitorLogPath)
      ? JSON.parse(fs.readFileSync(monitorLogPath, 'utf8'))
      : [];

    const updated = logId ? log.filter(e => e.logId !== logId) : [];
    fs.writeFileSync(monitorLogPath, JSON.stringify(updated, null, 2));
    return NextResponse.json({ success: true, count: updated.length });
  } catch (error) {
    console.error('Error DELETE /api/monitor-log:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
