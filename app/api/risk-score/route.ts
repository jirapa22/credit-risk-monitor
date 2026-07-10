import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
  const { customerData } = await request.json();
  const historyPath = path.join(process.cwd(), 'psi-history.json');
  
  // สมมติค่า PSI จากข้อมูล (เพื่อให้เห็นการเปลี่ยนแปลง)
  const newPsi = (customerData.income * 0.000001) + 0.05;

  // เขียนค่าทับไฟล์เดิมทันทีเพื่อให้ Dashboard เห็น
  fs.writeFileSync(historyPath, JSON.stringify({ psi: newPsi }));

  return NextResponse.json({ status: 'ok', psi: newPsi });
}