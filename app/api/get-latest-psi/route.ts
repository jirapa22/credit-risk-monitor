import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  try {
    // 1. บอกตำแหน่งไฟล์ที่เราเก็บประวัติไว้
    const historyPath = path.join(process.cwd(), 'psi-history.json');
    
    // 2. ถ้าไฟล์ไม่มีอยู่จริง ให้ส่งค่า PSI = 0 กลับไปก่อน
    if (!fs.existsSync(historyPath)) {
      return NextResponse.json({ latestPsi: 0 });
    }
    
    // 3. อ่านข้อมูลจากไฟล์
    const fileContent = fs.readFileSync(historyPath, 'utf8');
    const history = JSON.parse(fileContent);
    
    // 4. เลือกค่า PSI ล่าสุด (ตัวสุดท้ายในลิสต์)
    const latest = history.length > 0 ? history[history.length - 1] : { psi: 0 };
    
    // 5. ส่งค่ากลับไปให้หน้า Dashboard
    return NextResponse.json({ latestPsi: latest.psi });
  } catch (error) {
    return NextResponse.json({ latestPsi: 0 });
  }
}