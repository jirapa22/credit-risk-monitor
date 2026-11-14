# ชุดทดสอบ สินเชื่อเงินสด v2 (คะแนนคำนวณจากตารางโมเดลจริง)

## ไฟล์
- baseline_cashloan_v2_2024.csv  = Baseline (5,000 แถว, bad rate 12.5%, AUC 0.75)
- model_table_cashloan.csv       = ตารางโมเดล (8 ตัวแปรในโมเดล, 27 pool, base_points 453)
- m01..m06                       = ข้อมูล Monitoring 6 เดือน

## บทบาทคอลัมน์
app_id=ID | app_date=Date | credit_score=Score (สูง=ปลอดภัย) | default_12m=Target
ตัวแปรในโมเดล: age, employment_years, monthly_income, dti, ncb_inquiries_6m, ncb_max_dpd_12m, credit_util_pct, occupation, residence_type
นอกโมเดล: branch_region, channel, loan_amount, term_months, existing_debt_payment

## เฉลยแต่ละเดือน
- m01, m02 ปกติ -> CONTINUE
- m03 ระบบต้นทางมีปัญหา: รายได้ภาคอีสาน 90 แถวเป็นหลักพัน, อาชีพ "พนง.บริษัท" 52 แถว (ไม่เคยเห็น), credit_util_pct ว่าง 79 แถว -> INVESTIGATE_DATA
- m04 ส่งข้อมูลซ้ำ 36 แถว -> INVESTIGATE_DATA
- m05 แคมเปญ Mobile App: ประชากรเปลี่ยน (score PSI สูง) bad rate 18.9% -> INVESTIGATE_DRIFT / ติดตามใกล้ชิด
- m06 เศรษฐกิจชะลอ: bad rate 15.5% สูงกว่าที่โมเดลคาด -> concept drift (RETRAIN / CONSIDER_RETRAIN)

## หมายเหตุ
คะแนน = base_points + ผลรวม points ของ pool ที่ตกอยู่ (ขอบบน inclusive) ระบบควรรายงานคะแนนตรงตาราง ~100% ยกเว้น m03 ที่ถูกใส่ข้อมูลผิดตั้งใจ
