# Sample Datasets for Baseline Registry & Monitoring (Step 10c)

ชุดไฟล์ตัวอย่างสำหรับทดสอบการนำเข้าโมเดลภายนอกผ่านหน้าเว็บ **🗂 Baseline Registry** (`➕ นำเข้า Baseline ใหม่`) และการอัปโหลดไฟล์ตรวจติดตามในแท็บ **📊 Monitoring** โดยไม่ต้องเขียนโค้ดหรือแก้ไข JSON

---

## 1. โมเดลภายนอกแบบ `score_column` (`ext_gbm_v1`)

### `samples/baseline_ext_model.csv`
- **วัตถุประสงค์**: ไฟล์ Reference Dataset สำหรับสร้าง Baseline ใหม่ในโหมด `score_column` (300 แถว)
- **คอลัมน์ในไฟล์** (ตั้งชื่อไม่ตรงกับค่าเริ่มต้น เพื่อทดสอบระบบ Suggest อัตโนมัติ):
  | ชื่อคอลัมน์ | บทบาทที่ระบบควรเดา (`role`) | ชนิดข้อมูล (`type`) | คำอธิบาย |
  | --- | --- | --- | --- |
  | `cust_no` | `id` | `string` | รหัสลูกค้า (`EXT0001`–`EXT0300`, ไม่ซ้ำทุกแถว) |
  | `app_date` | `date` | `date` | วันที่สมัคร (`YYYY-MM-DD`) |
  | `รายได้ต่อเดือน` | `feature` | `numeric` | รายได้ต่อเดือนของลูกค้า (บาท, มีความเบ้ขวา) |
  | `วงเงินสินเชื่อ` | `feature` | `numeric` | วงเงินที่ขอสินเชื่อ (บาท) |
  | `สัดส่วนภาระหนี้` | `feature` | `numeric` | อัตราส่วนภาระหนี้ต่อรายได้ (`0.10`–`0.95`) |
  | `กลุ่มอาชีพ` | `feature` | `categorical` | อาชีพลูกค้า (`พนักงานบริษัท`, `ข้าราชการ`, `ค้าขาย`, `อาชีพอิสระ`) |
  | `pd_score` | `score` | `numeric` | ความน่าจะเป็นผิดนัดชำระหนี้ (`0.01`–`0.85`, คะแนนสูง = เสี่ยงสูง `higher_is_riskier`) |
  | `flag_npl_90` | `label` | `binary` | สถานะหนี้เสีย 90+ วัน (`0` = ปกติ, `1` = หนี้เสีย) |
- **ผลที่คาดหวังเมื่อนำเข้าใน Wizard**:
  1. ระบบเดา `role` ของทุกคอลัมน์ถูกต้อง (`cust_no` → `id`, `app_date` → `date`, `pd_score` → `score`, `flag_npl_90` → `label`, อีก 4 คอลัมน์ → `feature`)
  2. ระบบเลือกโหมด `score_column` อัตโนมัติ และตรวจทิศทางคะแนนได้เป็น `higher_is_riskier` (`คะแนนสูง = เสี่ยงสูง / PD`, AUC ≈ 0.84)
  3. เมื่อกด **Validate** จะผ่าน (`VALIDATED`, 0 errors) และสามารถกด **Activate** เพื่อเปิดใช้งานได้ทันที

---

## 2. ไฟล์สำหรับทดสอบ Monitoring ของโมเดล `ext_gbm_v1`

หลังจาก Activate โมเดลจาก `baseline_ext_model.csv` แล้ว สามารถนำไฟล์ทั้ง 3 ด้านล่างไปอัปโหลดในแท็บ **📊 Monitoring**:

### `samples/monitor_ext_clean.csv`
- **ลักษณะข้อมูล**: ข้อมูลลูกค้าใหม่ 200 แถวที่มีการกระจายตัวใกล้เคียงกับ Reference (`baseline_ext_model.csv`)
- **ผลที่คาดหวัง**:
  - Validation: ผ่านครบทุกแถว (`validRows = 200`)
  - Drift Status: `STABLE` (ทั้ง Score PSI และ CSI รายตัวแปรอยู่ในเกณฑ์ปกติ)
  - Trigger Action: `CONTINUE`

### `samples/monitor_ext_drift.csv`
- **ลักษณะข้อมูล**: ข้อมูลลูกค้าใหม่ 200 แถวที่เกิดการเลื่อนไหลของประชากรจริง (`รายได้ต่อเดือน` ลดลง, `สัดส่วนภาระหนี้` และ `pd_score` สูงขึ้น, สัดส่วน `กลุ่มอาชีพ` เปลี่ยนไปทาง `อาชีพอิสระ`)
- **ผลที่คาดหวัง**:
  - Validation: ผ่าน
  - Drift Status: `CRITICAL` (พบทั้ง Covariate Drift บนตัวแปรตัวเลข/ตัวแปรกลุ่ม และ Score PSI สูงเกินเกณฑ์)
  - Trigger Action: `INVESTIGATE_DRIFT` หรือ `CONSIDER_RETRAIN`

### `samples/monitor_ext_dirty.csv`
- **ลักษณะข้อมูล**: ข้อมูลลูกค้าใหม่ 200 แถวที่มีปัญหาคุณภาพข้อมูลปะปน (เช่น ค่าติดลบ, ค่าผิดหน่วย ×100, หมวดอาชีพใหม่ที่ไม่เคยพบใน Reference, รหัสลูกค้าซ้ำ)
- **ผลที่คาดหวัง**:
  - Validation & Anomaly Screening: ตรวจพบแถวที่มีค่าผิดปกติ / หมวดหมู่ไม่เคยพบ (`UNSEEN_CATEGORY`) / ค่าสุดโต่ง
  - Trigger Action: แจ้งเตือนให้ตรวจสอบคุณภาพข้อมูล (`INVESTIGATE_DATA`) หรือแยกแยะระหว่างข้อมูลสกปรกกับ Drift จริง

---

## 3. ไฟล์ Scorecard มาตรฐาน (`ascore_v1`)

### `samples/ascore_scorecard.csv`
- **วัตถุประสงค์**: ตารางสกอร์การ์ดของโมเดล `ascore_v1` ในรูปแบบ CSV มาตรฐาน (`variable,upper_bound,points,bin_label,woe,bad_rate,count` พร้อมแถว `base_points`)
- **การทดสอบ**:
  - ใช้ทดสอบ `POST /api/registry/scorecard/import` หรือการนำเข้าสกอร์การ์ดในโหมด `scorecard`
  - เมื่อคำนวณคะแนนย้อนกลับบน Reference `ascore_v1_dev855` จะได้คะแนนตรงกับ `calculateAScore` 100% ทุกแถว

