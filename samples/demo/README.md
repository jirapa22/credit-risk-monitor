# ชุดไฟล์ข้อมูลตัวอย่างสำหรับทดลองและสาธิตระบบ (Demo Pack)

ชุดไฟล์ข้อมูลในโฟลเดอร์นี้จัดทำขึ้นเพื่อใช้ในการทดลองใช้งาน, สาธิต (Demo) และการทดสอบใน **Step 14** โดยครอบคลุมทั้งข้อมูลที่สะอาด, ข้อมูลผิดพลาด (Data Errors), ปัญหาเชิงโครงสร้าง (Schema Breaks), และรูปแบบการเลื่อนของข้อมูล (Drift Injections)

---

## วิธีใช้งานระบบ 2 รูปแบบหลัก (User Workflows)

### (ก) รูปแบบที่ 1: การเพิ่มโมเดลใหม่เข้าสู่ระบบ (New Model Onboarding)
1. **เข้าสู่ Wizard**: ไปที่หน้า Dashboard แล้วเลือกเมนู *"เพิ่มโมเดลใหม่ / Baseline Onboarding"*
2. **อัปโหลดไฟล์ Baseline**: ลากหรือเลือกไฟล์ `baseline.csv` ที่เตรียมไว้
3. **ตรวจสอบและยืนยันบทบาทคอลัมน์**:
   - ระบบจะตรวจหาคอลัมน์ให้อัตโนมัติ ให้ยืนยันบทบาทของแต่ละคอลัมน์ (ID, Date, Score, Label, Features) และกำหนดทิศทางคะแนน (`ScoreDirection`)
4. **ตรวจสอบความพร้อม (Validate Baseline)**:
   - กดปุ่ม *"Validate"* เพื่อตรวจสอบคุณภาพข้อมูล, คำนวณค่า AUC, Gini, KS และคำนวณ Calibrated Thresholds
5. **เปิดใช้งาน (Activate)**:
   - เมื่อผลตรวจสอบผ่าน ให้กดปุ่ม *"Activate Baseline"* โมเดลจะพร้อมสำหรับการติดตามผลรายเดือนทันที

---

### (ข) รูปแบบที่ 2: การติดตามผลรายเดือน (Monthly Monitoring & Action Review)
1. **เลือกโมเดล**: เลือกแท็บโมเดลที่ต้องการติดตาม (เช่น `ascore_v1` หรือ `ext_model`)
2. **อัปโหลดไฟล์ข้อมูลประจำเดือน**: ลากหรือเลือกไฟล์ CSV ของเดือนนั้น
3. **อ่านผลการประเมินและคำแนะนำ**:
   - ตรวจสอบสถานะ Drift รวม, ค่า PSI/CSI, และคำแนะนำแอ็กชัน (`TriggerAction`) จากระบบ
4. **ตรวจแถวที่โดนปักธง / ถูกตัด**:
   - ตรวจสอบตาราง Anomaly Screening และ Data Validation เพื่อดูว่ามีแถวที่กรอกข้อมูลผิดพลาดหรือไม่
   - หากพบแถวผิดพลาด สามารถกด Exclude Rows เพื่อจำลองผล Drift ที่แท้จริงได้ทันที

---

## 1. แบบจำลองหลัก: `ascore_v1` (Scorecard ภายในองค์กร)

โฟลเดอร์: `samples/demo/ascore_v1/` (ขนาดไฟล์ละ 500 แถว)

| ไฟล์ | สถานการณ์ | แถว | ถูกตัด | โดนธง | Covariate (Fixed/Cal) | Concept | Label | Action (Fixed) | Action (Calibrated) | หมายเหตุ |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :--- |
| `01_clean.csv` | ข้อมูลปกติ (Clean Bootstrap) | 500 | 0 | 19 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | ข้อมูลปกติ ไม่พบความผิดปกติหรือ drift |
| `02_data_error_5pct.csv` | หน่วยเงินผิด ×10 จำนวน 5% (Data Error) | 500 | 0 | 44 | STABLE / CRITICAL | STABLE | STABLE | **INVESTIGATE_DATA** (R8b) | **INVESTIGATE_DATA** (R2) | ค่าขยาย 10 เท่า จับได้ในชั้น Screening (IQR/MAD) หรือ Validation |
| `03_data_error_20pct.csv` | ค่าสุดขั้ว 20% (Extreme Outlier) | 500 | 0 | 115 | WARNING / CRITICAL | STABLE | STABLE | **INVESTIGATE_DATA** (R2) | **INVESTIGATE_DATA** (R2) | ปักธงแถวผิดปกติได้มาก เมื่อตัดแถวออกแล้ว Drift กลับเป็น STABLE (R2) |
| `04_schema_break.csv` | โครงสร้างไฟล์ผิด (Schema Break - ขาดคอลัมน์จำเป็น) | 500 | 500 | 0 | STABLE / STABLE | STABLE | STABLE | **BLOCKED_INVALID_DATA** (R1) | **BLOCKED_INVALID_DATA** (R1) | ถูกบล็อกที่ชั้น Validation (BLOCKED_INVALID_DATA) |
| `05_rejected_rows.csv` | หน่วยเงินผิด ×100 จำนวน 10% (ถูก Validation ตัดทิ้ง) | 500 | 50 | 16 | STABLE / STABLE | STABLE | STABLE | **INVESTIGATE_DATA** (R1b) | **INVESTIGATE_DATA** (R1b) | ค่านอกช่วงยอมรับ โดนตัด 10% เข้ากฎ R1b แนะนำตรวจสอบต้นทาง |
| `06_mix_shift.csv` | การกระจายประชากรเลื่อน (+20 จุด% Mix Shift) | 500 | 0 | 20 | WARNING / CRITICAL | STABLE | STABLE | **MONITOR_CLOSELY** (R8) | **INVESTIGATE_DRIFT** (R7) | ลูกค้ากลุ่มเสี่ยงสูงเพิ่มขึ้นชัดเจน Covariate Drift เตือน |
| `07_label_shift.csv` | อัตราหนี้เสียเพิ่มขึ้น 2 เท่า (Label Shift ×2) | 500 | 0 | 19 | STABLE / STABLE | STABLE | CRITICAL | **RECALIBRATE** (R5) | **MONITOR_CLOSELY** (R8) | Bad Rate เพิ่มขึ้นชัดเจน แต่ความสามารถจัดอันดับ (AUC) ยังดี -> RECALIBRATE |
| `08_concept_shift.csv` | ความสัมพันธ์ตัวแปรกับหนี้เสียเปลี่ยน (สลับ Label 100%) | 500 | 0 | 19 | STABLE / STABLE | CRITICAL | STABLE | **CONSIDER_RETRAIN** (R4) | **CONSIDER_RETRAIN** (R4) | Gini/AUC ตกฮวบเหลือใกล้ 0 เกิด Concept Drift วิกฤต -> CONSIDER_RETRAIN |
| `09_multivariate.csv` | ความสัมพันธ์ข้ามตัวแปรผิดปกติ 10% (รายได้น้อยแต่กู้สูงผิดเกณฑ์) | 500 | 0 | 66 | STABLE / CRITICAL | STABLE | STABLE | **INVESTIGATE_DATA** (R8b) | **INVESTIGATE_DATA** (R2) | ความผิดปกติหลายมิติจับได้ด้วย LOF / Isolation Forest |
| `month_01.csv` | เดือนที่ 1 (ปกติ) | 500 | 0 | 24 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | ประชากรปกติ |
| `month_02.csv` | เดือนที่ 2 (ปกติ) | 500 | 0 | 15 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **MONITOR_CLOSELY** (R8) | ประชากรปกติ |
| `month_03.csv` | เดือนที่ 3 (ปกติ) | 500 | 0 | 26 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | ประชากรปกติ |
| `month_04.csv` | เดือนที่ 4 (ปกติ) | 500 | 0 | 25 | STABLE / STABLE | WARNING | STABLE | **MONITOR_CLOSELY** (R8) | **CONTINUE** (R9) | ประชากรปกติ |
| `month_05.csv` | เดือนที่ 5 (ปกติ) | 500 | 0 | 20 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | ประชากรปกติ |
| `month_06.csv` | เดือนที่ 6 (Drift สะสม 14%) | 500 | 0 | 21 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | เริ่มตรวจพบ Drift |
| `month_07.csv` | เดือนที่ 7 (Drift สะสม 29%) | 500 | 0 | 18 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | เริ่มตรวจพบ Drift |
| `month_08.csv` | เดือนที่ 8 (Drift สะสม 43%) | 500 | 0 | 20 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | เริ่มตรวจพบ Drift |
| `month_09.csv` | เดือนที่ 9 (Drift สะสม 57%) | 500 | 0 | 17 | STABLE / CRITICAL | STABLE | STABLE | **CONTINUE** (R9) | **INVESTIGATE_DRIFT** (R7) | Drift รุนแรงต่อเนื่อง (R6 พิจารณา Retrain) |
| `month_10.csv` | เดือนที่ 10 (Drift สะสม 71%) | 500 | 0 | 20 | STABLE / CRITICAL | STABLE | STABLE | **CONTINUE** (R9) | **CONSIDER_RETRAIN** (R6) | Drift รุนแรงต่อเนื่อง (R6 พิจารณา Retrain) |
| `month_11.csv` | เดือนที่ 11 (Drift สะสม 86%) | 500 | 0 | 25 | WARNING / CRITICAL | STABLE | STABLE | **MONITOR_CLOSELY** (R8) | **CONSIDER_RETRAIN** (R6) | Drift รุนแรงต่อเนื่อง (R6 พิจารณา Retrain) |
| `month_12.csv` | เดือนที่ 12 (Drift สะสม 100%) | 500 | 0 | 18 | WARNING / CRITICAL | STABLE | STABLE | **MONITOR_CLOSELY** (R8) | **CONSIDER_RETRAIN** (R6) | Drift รุนแรงต่อเนื่อง (R6 พิจารณา Retrain) |

---

## 2. แบบจำลองภายนอก: `ext_model` (โหมด External Score Column)

โฟลเดอร์: `samples/demo/ext_model/` (ขนาดไฟล์ละ 500 แถว)

| ไฟล์ | สถานการณ์ | แถว | ถูกตัด | โดนธง | Covariate (Fixed/Cal) | Concept | Label | Action (Fixed) | Action (Calibrated) | หมายเหตุ |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :--- |
| `01_clean.csv` | ข้อมูลปกติ (Clean Bootstrap) | 500 | 0 | 11 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | ข้อมูลปกติสำหรับโมเดลภายนอก (score_column) |
| `02_unseen_category.csv` | พบหมวดหมู่ใหม่ที่ไม่เคยมีใน Reference 5% (Unseen Category) | 500 | 0 | 36 | CRITICAL / CRITICAL | STABLE | STABLE | **INVESTIGATE_DATA** (R1b) | **INVESTIGATE_DATA** (R1b) | จัดเข้ากลุ่ม __UNSEEN__ และแจ้งเตือนแถวผิดปกติ (R1b/Screening) |
| `03_category_shift.csv` | สัดส่วนกลุ่มอาชีพเปลี่ยน (Category Shift) | 500 | 0 | 11 | CRITICAL / CRITICAL | STABLE | STABLE | **INVESTIGATE_DRIFT** (R7) | **INVESTIGATE_DRIFT** (R7) | สัดส่วนหมวดหมู่อาชีพเปลี่ยน Jensen-Shannon distance และ CSI สูงขึ้น |
| `04_missing_drift.csv` | ค่าว่างเพิ่มขึ้นอย่างมีนัยสำคัญ (Missing Drift) | 500 | 0 | 11 | STABLE / CRITICAL | STABLE | STABLE | **INVESTIGATE_DATA** (R1b) | **INVESTIGATE_DATA** (R1b) | missing rate เพิ่มขึ้นมากกว่าเกณฑ์ (R3 ตรวจระบบต้นทาง) |

---

## 3. แบบจำลองใหม่: `new_model_auto_loan` (สำหรับทดสอบ Wizard ใน Step 14)

โฟลเดอร์: `samples/demo/new_model_auto_loan/`
> **หมายเหตุสำคัญ**: โมเดลนี้ **ไม่ได้ถูกลงทะเบียนไว้ล่วงหน้าในระบบ** เพื่อให้ผู้ประเมินสามารถทดลองกระบวนการ Onboarding ผ่าน Wizard ได้จริง

### รายละเอียดข้อมูล Baseline (`baseline.csv`)
- **จำนวนแถว**: 600 แถว
- **จำนวนหนี้เสีย (NPL)**: 68 สัญญา (Bad Rate = 11.3%)
- **ประสิทธิภาพโมเดลบน Baseline (AUC)**: **0.729** (อยู่ในช่วงเป้าหมาย 0.70–0.75)

### เฉลยการตั้งค่าบทบาทคอลัมน์ใน Wizard (Step 14 Column Mapping):
| ชื่อคอลัมน์ | บทบาทที่ต้องเลือก (Column Role) | ประเภทข้อมูล | หมายเหตุ |
| :--- | :--- | :--- | :--- |
| `เลขที่สัญญา` | **ID** | Identifier | รหัสสัญญาอ้างอิง |
| `วันที่อนุมัติ` | **Date** | Date (YYYY-MM-DD) | วันที่เริ่มสัญญา |
| `ราคารถ` | **Feature** | Numeric | ราคารถยนต์ (บาท) |
| `เงินดาวน์_pct` | **Feature** | Numeric | สัดส่วนเงินดาวน์ (%) |
| `ระยะผ่อน_เดือน` | **Feature** | Numeric | ระยะเวลาผ่อนชำระ |
| `ประเภทรถ` | **Feature** | Categorical | รถเก๋ง / รถกระบะ / รถ SUV / รถตู้ |
| `อายุผู้กู้` | **Feature** | Numeric | อายุผู้กู้ (ปี) |
| `risk_score` | **Score Column** | Numeric | **โหมด: score_column**, ทิศทาง: **higher_is_riskier** (คะแนนสูง = เสี่ยงสูง) |
| `npl_flag` | **Label (Target)** | Binary | 0 = ปกติ, 1 = หนี้เสีย (NPL) |

### ผลลัพธ์จริงเมื่อนำไฟล์ไปมอนิเตอร์หลัง Activate:
| ไฟล์ | สถานการณ์ | แถว | ถูกตัด | โดนธง | Covariate (Fixed/Cal) | Concept | Label | Action (Fixed) | Action (Calibrated) | หมายเหตุ |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- | :--- |
| `monitor_clean.csv` | ติดตามรายเดือนปกติ (Clean 500 แถว) | 500 | 0 | 14 | STABLE / STABLE | STABLE | STABLE | **CONTINUE** (R9) | **CONTINUE** (R9) | ข้อมูลปกติ สอดคล้องกับประชากร Baseline |
| `monitor_drift.csv` | เงินดาวน์ลดลง + สัดส่วนประเภทรถเปลี่ยน (Covariate Drift) | 500 | 0 | 92 | CRITICAL / CRITICAL | STABLE | CRITICAL | **RECALIBRATE** (R5) | **INVESTIGATE_DRIFT** (R7) | เงินดาวน์เฉลี่ยลดลง และประเภทรถเปลี่ยนสัดส่วน (รถตู้/กระบะเพิ่มขึ้น) |

---

## ข้อสังเกตและพฤติกรรมของระบบ (System Insights)
1. **ความไวของเกณฑ์ Fixed vs Calibrated**:
   - ในโหมด **Fixed** ตัวชี้วัด Covariate Drift จะเตือนเมื่อค่า CSI/PSI เกินเกณฑ์สากล (0.10 / 0.25) เท่านั้น หากการกระจายตัวขยับในระดับปานกลาง ค่า CSI อาจยังไม่แตะ 0.10 ทำให้ผลคงเป็น STABLE (บันทึกเป็นข้อจำกัดของเกณฑ์อุตสาหกรรม)
   - ในโหมด **Calibrated** ระบบใช้ Null Distribution Bootstrap ร่วมกับการปรับ family-wise Bonferroni ทำให้มีความไวต่อการเลื่อนของตัวแปรจริงตามขนาดกลุ่มตัวอย่าง $n$
2. **การทำงานของกฎ R1b (Validation Issues)**:
   - เมื่อข้อมูลมีแถวถูกตัดทิ้ง (เช่น หน่วยผิด ค่านอกช่วง) หรือมีแถวซ้ำ เกินกว่า 1% กฎ **R1b** จะดักจับและส่งแอ็กชัน **INVESTIGATE_DATA** ทันที เพื่อป้องกันไม่ให้ข้อผิดพลาดของข้อมูลถูกมองข้ามแม้ผล Drift บนแถวที่เหลือจะยังปกติ
3. **การทำงานของกฎ R2 (Exclusion Rescue)**:
   - ในกรณีค่าสุดขั้ว (`03_data_error_20pct.csv`) ข้อมูลผ่าน Validation แต่ถูกปักธงในชั้น Anomaly Screening และเมื่อตัดแถวที่โดนธงออก ผล Drift กลับมาเป็น STABLE ทั้งคู่ กฎ R2 จะยืนยันอย่างแม่นยำว่าเป็น **INVESTIGATE_DATA**
