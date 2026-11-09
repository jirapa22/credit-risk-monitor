# IS Progress Log — A-Score Monitor / Model Monitoring Sandbox

> บันทึกรายละเอียดระบบสำหรับสรุปรวมตอนระบบเสร็จ (ดูแลโดย Claude — อัปเดตทุกครั้งที่จบ Step)
> Repo: github.com/jirapa22/credit-risk-monitor · Production: https://credit-risk-monitor-eight.vercel.app/dashboard
> Vercel project: credit-risk-monitor (team: tawfun)

## กรอบงาน (ปรับล่าสุด 8 พ.ย. 2569 ตามคำแนะนำอาจารย์ + MADT8102 Ch.7 MLOps)
- ชื่อเรื่อง (ร่าง): การพัฒนาองค์ประกอบ Model Monitoring ตามแนวทาง MLOps สำหรับตรวจจับ Data Drift ของแบบจำลองคะแนนความเสี่ยงสินเชื่อ โดยแยกความผิดปกติของคุณภาพข้อมูลออกจากการเปลี่ยนแปลงจริงของประชากร
- คำถามหลัก: จะเชื่อสัญญาณ drift ได้แค่ไหน และระบบแยก "drift จริง" ออกจาก "ข้อมูลผิด" ได้หรือไม่
- AS-IS = MLOps level 0 (คำนวณ PSI ใน Excel ด้วยมือ) → TO-BE = Monitoring component อัตโนมัติ + trigger
- Pipeline: Baseline Registry → [1–2] Data Validation → [3–4] Edge-case screening → Drift Report → Trigger → คนรีวิว
- เอกสารอ้างอิงจากวิชา: slide 4 (CI for data), 7–8 (level 0), 12 (monitoring→trigger, model registry), 14–16 (distribution/label/concept drift), 17 (uni/multi-dimensional edge cases), 19 (missing-as-a-feature), 22–24 (feature store), 29 (log transform)
- หลักความยืดหยุ่น (กติกาถาวร): ไม่ hard-code ชื่อตัวแปร/คอลัมน์/เกณฑ์; ส่วนที่ไม่มีข้อมูล = NOT_AVAILABLE; สถิติอ้างอิงคำนวณจาก Reference; ทุก Step ทดสอบกับโมเดลปลอมตัวที่สอง; ผลทุกครั้งผูก modelId + configVersion + referenceId

## Step ที่เสร็จแล้ว
| Step | Commit | งาน |
|---|---|---|
| 0 | 0e5d391 | commit งานเดิม: validation layer, drift pipeline, storage, sandbox types |
| 1 | 18c37c3 | ชั้น 3: IQR / Robust Z (MAD) / cross-field rules + log1p transform |
| 2 | ae5b87d | ชั้น 4: Isolation Forest + LOF (TypeScript ล้วน, seed ได้, threshold p99 LOO บน Reference) |
| 3 | bff243f | ต่อเข้า pipeline + drift สองแบบ (ทุกแถว / ตัดแถวโดนธงแบบ symmetric) |
| 4 | 13d0027 | ตัวฉีดความผิดปกติ 12 แบบ + เฉลยรายแถว (bootstrap จาก Reference) |
| 5 | f886588 | experiment runner + metric รายแถว/ระดับไฟล์ + export CSV |
| 5b | 926868a | ผล grid เต็ม 3,895 trial (51 นาที) ใน results/ |
| 6 | 825e704 | UI: Sandbox → Anomaly Experiment (ทดลองเอง + heatmap ผลเต็ม) — deploy แล้ว |
| 8 | fc23014 | Drift Report: covariate (PSI/CSI, distribution profile, KS, Wasserstein) / missing / label / concept |
| 9 | 9a212a0 | Trigger แบบกฎใน config (R1–R9) + review workflow (human-in-the-loop, audit) |
| 10a | 67d02b1 | Baseline Registry: lifecycle DRAFT→VALIDATED→ACTIVE→ARCHIVED, blob storage, auto validation, export/import |

## ข้อค้นพบ (ใช้ในบทที่ 4)
1. Log1p แก้ปัญหาข้อมูลเบ้: MAD ติดธงบน Reference 7.25% → 1.3%, IQR 9.4% → 3.0%; ขอบล่าง IQR จากติดลบ → 7,781 บาท (จับรายได้กรอกผิดหน่วยได้)
2. IF จับความผิดปกติหลายตัวแปรแบบ "แต่ละค่าปกติ" ไม่ได้ 0/30 seed (score ต่ำกว่าเกณฑ์ ~5.9 SD) — LOF จับได้ (2.12 vs 1.515); IQR/MAD จับไม่ได้เลย → เหตุผลของชั้น 4 และของการใช้ LOF คู่ IF
3. ข้อมูลผิด 5% (×10) ทำ CSI รายได้สูงขึ้น ~55 เท่า (0.0002 → 0.0110); ตัดแถวโดนธงแบบ symmetric แล้วกลับเท่าไฟล์สะอาด; จับได้ 43/43 แถว
4. PSI/CSI มองไม่เห็นข้อมูลผิดใน bin ปลายเปิด (>36,360) — ค่าผิด ×10 ตกช่องเดิม; Wasserstein จับได้ (CSI 0.018 vs W 0.295)
5. ตัดแถวโดนธงอัตโนมัติอาจลบ drift จริง (variance_change: WARNING → STABLE) → ต้องให้คนตัดสินใจ, driftExcludingFlagged เป็น what-if เท่านั้น
6. ตัววัดที่ไวขึ้น (Wasserstein) ไวต่อข้อมูลผิดด้วย → ชั้นตรวจข้อมูลยิ่งจำเป็น
7. แยก label drift ออกจาก covariate ได้ (bad rate 9.36% → 18.01%: label CRITICAL, covariate STABLE)
8. Trigger แนะนำต่างกันตามชนิดปัญหา: ข้อมูลผิด 20% → INVESTIGATE_DATA; mean shift → INVESTIGATE_DRIFT → (ซ้ำ) CONSIDER_RETRAIN; label drift → RECALIBRATE; concept drift (Gini 0.42→0.06) → CONSIDER_RETRAIN
9. ข้อจำกัด: swapped_columns หลุด ~35% (ค่าที่สลับยังสมเหตุสมผล)
10. ผลรอบ quick: กลุ่มข้อมูลผิด routing ถูก 100%, none ไม่มี false alarm, อัตราธงพื้นฐาน ~4%; LOF > IF (extreme_outlier 1.00 vs 0.29; multivariate 1.00 vs 0.56)
11. Registry: โมเดลปลอม (age/salary/utilization, is_bad) ลงทะเบียน→ใช้งานได้ครบโดยไม่แก้โค้ด; ascore_v1 AUC/Gini/KS บน Reference = 0.711 / 0.421 / 0.324

## ค่าสำคัญของระบบ
- Reference: ascore_v1_dev855 (855 แถว, bad 80 = 9.36%, sha256 f7255c63…), scoreDirection = higher_is_safer
- เกณฑ์: PSI 0.10/0.25, CSI 0.10, KS D 0.10/0.20, Wasserstein 0.10/0.25 (ชั่วคราว รอปรับใน Step 11), IQR k=1.5, MAD |z|>3.5, IF/LOF contamination 0.01, LOF k=20, IF 100 ต้น ψ=256 seed 42
- Severity table: unit_error ×10/×100/×1000; extreme_outlier p99×1.5/3/10; mean_shift −10/−20/−40%; variance ×1.25/1.5/2

## คงค้าง / Step ถัดไป
- 10b score_column mode + ล้าง hard-code + guard test (prompt ส่งแล้ว 9 พ.ย.)
- 10b-2 รองรับตัวแปร categorical ทุกชั้น (พบช่องว่าง 9 พ.ย.: ทุกชั้นตรวจเฉพาะ numeric → ตัวแปรแบบกลุ่มถูกข้ามเงียบ ๆ) — CSI รายหมวด, chi-square, Jensen–Shannon, UNSEEN_CATEGORY, category_shift/unseen_category injection
- 10c UI Baseline Registry (รวมล้าง hard-code ใน app/dashboard/page.tsx) + ลดงานกรอกของผู้ใช้ (บันทึก 9 พ.ย.):
  (1) auto-detect scoreDirection จาก label (AUC > 0.5)
  (2) เดาบทบาทคอลัมน์จากชื่อ (id / flag,bad,default / score / date)
  (3) แนะนำ min/max จาก Reference ให้ผู้ใช้ยืนยัน
  (4) นำเข้า scorecard จาก CSV/Excel แทน JSON
  หลักการ: ผู้ใช้เตรียมไฟล์เดียว (ข้อมูลพัฒนาโมเดล + label + คอลัมน์ score) → ยืนยันบทบาทคอลัมน์ → Validate → Activate
- 10d (ใหม่ 9 พ.ย.) AI-assisted Baseline onboarding — ต่อยอดฟีเจอร์ 'AI Recommendation' ในสไลด์เค้าโครงเดิม:
  (1) AI จับคู่บทบาท/ชนิดคอลัมน์จากชื่อ+ค่าตัวอย่าง (เข้าใจชื่อไทย/ชื่อเฉพาะองค์กร)
  (2) AI ร่าง data dictionary ภาษาไทย + เสนอ min/max ทางธุรกิจพร้อมเหตุผล
  (3) AI ดึง scorecard จาก Excel model report (เช่น ascore_model_report.xlsx) → ระบบตรวจโครงสร้าง + คำนวณคะแนนเทียบคอลัมน์ score จริงก่อนรับ
  (4) AI อธิบาย validation report เป็นภาษาคน
  หลัก: AI เสนอ → ระบบตรวจ → คนยืนยัน; AI ไม่คำนวณตัวเลข; ส่งเฉพาะชื่อคอลัมน์/สถิติสรุป/ตัวอย่างที่ปิดบัง (PDPA); ไม่มี API key → fallback เป็นกฎ heuristic; บันทึกสิ่งที่ AI เสนอ vs ที่ผู้ใช้รับ/แก้
  การวัดผลในเล่ม: ความแม่นของการจับคู่คอลัมน์ heuristic vs AI บนหลาย Baseline + จำนวนจุดที่ผู้ใช้ต้องแก้
- 11 การทดลอง drift แบบใหม่ (label/concept/mix/gradual) + power curve (ขนาด drift × จำนวนแถว) เทียบ PSI/KS/Wasserstein + calibrate เกณฑ์
- 12 Lending Club เป็น Baseline ตัวที่สอง (score_column)
- 13 UI Monitoring Report (Data Quality + Drift + Trigger + review) + AI สรุป/อธิบาย Drift Report และ Trigger สำหรับผู้บริหาร (ตัวเลขทั้งหมดมาจากระบบ)
- "เรื่อง Upstash": production ยังเป็น storage memory (ไม่มี env vars) — ต้องตั้ง Upstash + Vercel Blob + API key ของ AI (สำหรับ 10d/13) ก่อน demo
- ยังไม่ทราบวันนำเสนอ Final
- เขียนเล่ม บทที่ 1–5 + สไลด์ Final
