import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const configPath = path.join(process.cwd(), 'app', 'model-config.json');
const historyPath = path.join(process.cwd(), 'psi-history.json');

export async function GET() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const history = fs.existsSync(historyPath)
      ? JSON.parse(fs.readFileSync(historyPath, 'utf8'))
      : [];

    return NextResponse.json({ config, history });
  } catch (error) {
    console.error('Error GET /api/get-latest-psi:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}