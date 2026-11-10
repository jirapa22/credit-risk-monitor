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
| 10b | 0a0b238 | โหมด score_column (โมเดลภายนอก), scoreDirection ทุกจุด, risk grade D1–D10 อัตโนมัติ, lib/defaults.ts, guard test no-hardcode (0 violations), ลบโค้ดเก่า (dataGenerator, utils/stats, api/risk-score); 109/109 tests |
| 10b-2 | 302e84a | ตัวแปร categorical ทุกชั้น: UNSEEN_CATEGORY, fillMode, __OTHER__/__UNSEEN__, CSI รายหมวด, chi-square, Jensen–Shannon, category_shift / unseen_category injection; 115/115 tests |

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

12. score_column: โมเดลปลอม ext_gbm_v1 (x1–x3, higher_is_riskier) AUC บน Reference 0.822; ไม่มีคอลัมน์ score → ส่วนที่ใช้คะแนน NOT_AVAILABLE แต่ CSI ได้; สลับ label → CONSIDER_RETRAIN
13. เปลี่ยน Baseline เวอร์ชัน: ผลของ v1 ยังอยู่และแยกจาก v2; persistence ของ trigger นับเฉพาะเวอร์ชันเดียวกัน (v2 รอบแรกได้ INVESTIGATE_DRIFT ไม่ใช่ CONSIDER_RETRAIN)
14. multivariate_inconsistent แบบทั่วไป (เลือกคู่ |Spearman| สูงสุด): ascore_v1 เลือก loan_amount–dti_ratio (ρ=+0.39); LOF recall low 1.00→0.95, medium/high 1.00
15. Categorical (โมเดลปลอม cat_credit_v1: occupation 5 หมวด, region 4 หมวด): category_shift 40 จุด% → CSI 2.73, JS distance 0.478, χ² 258.4 (df 4, p≈1e-54) ทั้งหมด CRITICAL; unseen_category 5% จับได้ 25/25 และ trigger = INVESTIGATE_DATA (drift ทางการ CRITICAL จาก __UNSEEN__ แต่ตัดแถวโดนธงแล้ว STABLE); 'Engineer'/' engineer '/'ENGINEER' = หมวดเดียวกัน

## หมายเหตุสำหรับผลการทดลอง
- ผล grid เต็ม 926868a (3,895 trial) ใช้นิยาม multivariate_inconsistent แบบเดิม (3 ตัวแปรคงที่) → ต้องรัน grid ใหม่ใน Step 11 ก่อนใช้ตัวเลขในเล่ม

## ค่าสำคัญของระบบ
- Reference: ascore_v1_dev855 (855 แถว, bad 80 = 9.36%, sha256 f7255c63…), scoreDirection = higher_is_safer
- เกณฑ์: PSI 0.10/0.25, CSI 0.10, KS D 0.10/0.20, Wasserstein 0.10/0.25 (ชั่วคราว รอปรับใน Step 11), IQR k=1.5, MAD |z|>3.5, IF/LOF contamination 0.01, LOF k=20, IF 100 ต้น ψ=256 seed 42
- Severity table: unit_error ×10/×100/×1000; extreme_outlier p99×1.5/3/10; mean_shift −10/−20/−40%; variance ×1.25/1.5/2

## ผลงานล่าสุด (Step 10c — เสร็จสมบูรณ์)
- หน้าเว็บ Baseline Registry + Onboarding Wizard 5 ขั้นตอน (app/dashboard/components/BaselineOnboardingWizard.tsx, BaselineRegistryPanel.tsx)
- ระบบวิเคราะห์และแนะนำอัตโนมัติ (Heuristic Suggestion Provider):
  - auto-detect scoreDirection จาก label (AUC > 0.5)
  - เดาบทบาทคอลัมน์จากชื่อและรูปแบบข้อมูล (id, date, label, score, feature, ignore)
  - แนะนำ min/max ปัดเศษสวยงาม และกลยุทธ์ missing value
- นำเข้า/ส่งออก Scorecard ในรูปแบบ CSV และ .xlsx (ใช้ Node built-in zlib ปลอดภัย ไม่พึ่งพาไลบรารีภายนอก xlsx) พร้อมตรวจคะแนนเทียบ Reference >= 99%
- แถบเลือกโมเดลที่หัวหน้าเว็บ + สลับโมเดล dynamic + ป้ายสถานะ + ปุ่ม "ตั้งเป็นค่าเริ่มต้น" (GET/POST /api/registry/default)
- ล้างจุด hard-code ชื่อคอลัมน์ A-Score ทั้งหมดใน app/dashboard/ และขยาย tests/no-hardcode.test.ts ครอบคลุมทั้งโปรเจกต์
- ชุดข้อมูลทดสอบตัวอย่าง (samples/): baseline_ext_model.csv, monitor_ext_clean.csv, monitor_ext_drift.csv, monitor_ext_dirty.csv, ascore_scorecard.csv
- ชุดทดสอบ tests/step10c.test.ts ผ่านครบทุกข้อ รวม 14 test suites (124 tests)

## คงค้าง / Step ถัดไป
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
- 14 (ใหม่ 9 พ.ย.) ประเมินกับผู้ใช้: ผู้ทดสอบ 3–5 คน เทียบ Excel vs ระบบ (เวลา, จับความผิดปกติได้กี่จุด, สรุปถูกไหม) + SUS 10 ข้อ + จับเวลานำเข้า Baseline ใหม่ผ่านหน้าเว็บ (หลักฐานความยืดหยุ่นจากมุมผู้ใช้) — Claude เตรียมแบบฟอร์ม/โจทย์/แบบสอบถาม/ตารางคำนวณ
- ผู้ใช้ยืนยัน 9 พ.ย.: ไม่ตัด Step ใด ๆ, คงหลักความยืดหยุ่น; ประมาณเวลาที่เหลือ ~2.5–3 สัปดาห์ (ระบบ 6–8 วัน + เล่ม/สไลด์ 7–10 วัน; ร่างบท 1–3 คู่ขนานได้)
- ยังไม่ทราบวันนำเสนอ Final
- เขียนเล่ม บทที่ 1–5 + สไลด์ Final
