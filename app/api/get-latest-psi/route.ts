import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { thresholds } from '../../config/model';

export async function GET() {
  try {
    // 1. บอกตำแหน่งไฟล์ที่เราเก็บประวัติไว้
    const historyPath = path.join(process.cwd(), 'psi-history.json');

    // 2. ถ้าไฟล์ไม่มีอยู่จริง ให้ส่งค่า PSI = 0 กลับไปก่อน
    if (!fs.existsSync(historyPath)) {
      return NextResponse.json({ latestPsi: 0, status: 'STABLE' });
    }

    // 3. อ่านข้อมูลจากไฟล์
    const fileContent = fs.readFileSync(historyPath, 'utf8');
    const history = JSON.parse(fileContent);

    // 4. เลือกค่า PSI ล่าสุด (ตัวสุดท้ายในลิสต์)
    const latest = history.length > 0 ? history[history.length - 1] : { psi: 0 };

    // 5. Determine alert status from config — no hardcoded threshold
    const latestPsi: number = latest.psi ?? 0;
    const status =
      latestPsi >= thresholds.psiCriticalThreshold
        ? 'CRITICAL'
        : latestPsi >= thresholds.psiWarnThreshold
        ? 'WARN'
        : 'STABLE';

    // 6. ส่งค่ากลับไปให้หน้า Dashboard
    return NextResponse.json({ latestPsi, status });
  } catch (error) {
    return NextResponse.json({ latestPsi: 0, status: 'STABLE' });
  }
}