import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(request: Request) {
  try {
    // 1. รับข้อมูลจากที่ส่งเข้ามา (ถ้าไม่มีส่งมา ให้ใช้ค่า Default)
    const body = await request.json().catch(() => ({}));
    const customerData = body.customerData || { income: 30000, emp_duration: 3, age: 30 };

    // 2. อ่าน Config
    const configPath = path.join(process.cwd(), 'model-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const model = config.models[config.activeModel];

    // 3. คำนวณ Score ด้วยสมการ
    const score = (customerData.income * model.weights.income) + 
                  (customerData.emp_duration * model.weights.emp_duration) + 
                  (customerData.age * model.weights.age) + 5;
    
    const psiValue = Math.abs(score);

    // 4. บันทึกลง psi-history.json (เพื่อให้ Dashboard อ่านค่าใหม่ได้)
    const historyPath = path.join(process.cwd(), 'psi-history.json');
    const history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    
    // เพิ่มข้อมูลใหม่เข้าไปใน Array
    history.push({ 
      date: new Date().toISOString(), 
      model: config.activeModel, 
      psi: psiValue 
    });
    
    // เขียนข้อมูลกลับลงไฟล์
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

    // 5. ส่งผลลัพธ์กลับไปให้ Dashboard
    return NextResponse.json({
      status: "success",
      modelName: model.name,
      psi: psiValue,
      inputUsed: customerData
    });

  } catch (error) {
    return NextResponse.json({ error: "Failed to process" }, { status: 400 });
  }
}