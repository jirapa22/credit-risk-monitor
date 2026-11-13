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
| 10c | d112f16, b56e460, 4d2ef3a | UI Baseline Registry + Wizard 5 ขั้น + แถบเลือกโมเดล; SuggestionProvider (heuristic) เดาบทบาท/ชนิดคอลัมน์, min/max, transform, scoreDirection อัตโนมัติ; นำเข้า/ส่งออก scorecard CSV/xlsx (ตัวอ่าน xlsx เขียนเองทุกชีต); samples/ สำหรับ demo; guard test ครอบ app/dashboard; build ผ่าน; 127/127 tests |

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
16. Onboarding heuristic: samples/baseline_ext_model.csv เดาถูก 8/8 คอลัมน์ (ชื่อไทย/ชื่อเฉพาะ); scoreDirection อัตโนมัติถูกทั้ง ascore_v1 (safer, AUC 0.711) และ ext model (riskier); scorecard export→import ตรง 100% (855/855, ต่าง 0.0000); scorecard แต้มผิด 1 bin (+20) → ตรงเพียง 78.36% ระบบเตือน
17. ข้อจำกัดของกฎ (ใช้เป็นเหตุผลของ AI ใน 10d): 'รายได้ต่อเดือน' เคยถูกจับเป็น date เพราะคำว่า 'เดือน' — แก้แล้วด้วยการตรวจชนิดข้อมูลก่อน (confidence 0.70→0.88); ชีต Scorecard ใน ascore_model_report.xlsx ใช้ป้าย bin เป็นข้อความ ('≤17,800', '17,801–22,300') ไม่ใช่ upper_bound → ต้องตีความ (งานของ AI)
18. PDPA payload (a22577e): สุ่มค่าตัวอย่างอิสระรายคอลัมน์ ไม่มีแถวใช้ซ้ำข้ามคอลัมน์, ปัด 2 หลักสำคัญ, วันที่ระดับเดือน, id ปิดบัง — ก่อนแก้ ค่าตัวอย่างลำดับเดียวกันมาจากแถวเดียวกัน (ประกอบเป็นลูกค้า 1 รายได้)
19. Heuristic (ล็อก sha ccc9807): development 96.15% (50/52; ตัวเลขนี้สูงเกินจริงเพราะกฎเดาจากค่าเพิ่มหลังเห็น Suite C), held-out 86.96% (20/23): D1 100%, D2 85.7% (วันเกิด → ignore, เฉลย = feature: เฉลยกำกวม ควรอภิปรายในเล่ม), D3 77.8% (ตัวแปร 0/1 สามตัว เลือก label ผิดเป็นตัวแรกที่เจอ)
20. เทียบตัวเดาคอลัมน์ (claude-sonnet-5-5, 10 พ.ย.; ไฟล์ results/eval_suggestions_*_2026-11-10T15-58/16-00/16-04): development heuristic 96.2% / AI 98.1% / combined 100%; HELD-OUT heuristic 87.0% (20/23) / AI 95.7% (22/23) / combined 87.0% (20/23). AI ชนะบน D2 (100% vs 85.7%) และ D3 (88.9% vs 77.8%). Combined (เลือกตาม confidence) แพ้ AI บน held-out เพราะ confidence ของกฎสูงเกินจริง (ไม่ calibrated) จึงชนะ AI ตอนเห็นต่าง — ดีบน dev เพราะกฎถูกจูนกับ dev. ต้นทุน: AI ~3,000 token/ชุด, ~6 วินาที/ชุด; รวมทั้งรอบ ~35k token

21. 11a (29a38f1): label_shift → label เท่านั้น → RECALIBRATE; concept_shift → concept เท่านั้น → CONSIDER_RETRAIN; mix_shift → covariate เท่านั้น → INVESTIGATE_DRIFT (ไม่มี section leakage). label_shift ใช้การพลิกแบบถ่วงตามความเสี่ยง (ต้องอธิบายในบท 3). mean_shift (คูณค่าโดยไม่แตะ label) ทำให้ concept เตือนด้วย = artifact ของวิธีจำลอง → ใช้ mix_shift เป็นสถานการณ์ covariate หลัก
22. จำลอง 12 เดือน: sudden mean_shift −20% เริ่ม M6 → false alarm 0 ใน M1–5, เตือน M6 (delay 0), CONSIDER_RETRAIN M7 (persistence); gradual ถึง −20% ที่ M12 → WARNING ตั้งแต่ M6 (−2.9%, เกณฑ์ชั่วคราวไวเกิน), CRITICAL M9, RETRAIN M10
23. 11b calibration (a344d31) ascore_v1: เกณฑ์ calibrated (p95/p99 ของ null bootstrap) n=250 → PSI 0.071/0.099, CSI income 0.037/0.057, KS 0.083/0.105, W 0.116/0.148; n=1000 → PSI 0.018/0.024, CSI 0.010/0.014, KS 0.042/0.047, W 0.056/0.067 (fixed: PSI/CSI 0.10/0.25, KS/W 0.10/0.20). False alarm ที่ n=250: fixed สูงสุด ~20% (Wasserstein), calibrated ~5%
24. Power (quick) mix_shift รายได้: n=1000 ที่ +10 จุด% → CSI fixed 0% vs calibrated 100%; ที่ +15 → CSI fixed 30%. เกณฑ์ PSI/CSI มาตรฐานไม่ไวกับ drift ระดับกลางในไฟล์ขนาดใหญ่ ส่วน calibrated ไวมาก
25. ประเด็นอภิปราย: calibrated = มีนัยสำคัญทางสถิติ แต่ที่ n ใหญ่จะเตือน shift เล็กที่อาจไม่มีผลทางธุรกิจ (PSI 0.018) → เสนอโหมด hybrid: เตือนเมื่อเกินเกณฑ์ calibrated และมีขนาดผลขั้นต่ำ (เช่น PSI ≥ 0.05) — ทำใน Step 13 หรือเป็นงานอนาคต

26. Grid เต็ม 25f37be (ascore_v1 4,795 trial / ext_model, a344d31): ข้อมูลผิดทุกชนิด all_layers recall = 1 (ยกเว้น swapped_columns ascore 0.61, multivariate ext 0.86); precision ของ all_layers ที่ rate 5% = 0.59 (ascore) / 0.75 (ext) เพราะธงพื้นฐาน ~4% บนแถวปกติ
27. LOF vs IF ขึ้นกับข้อมูล: multivariate_inconsistent ascore LOF 1.00 / IF 0.23 แต่ ext_model IF 0.78 / LOF 0.65 → เหตุผลที่ต้องใช้คู่กัน (all_layers 0.86)
28. ระดับไฟล์: ข้อมูลผิด 5% แทบไม่ทำให้ PSI/CSI ทางการเตือน (alarm 0–3%); ที่ 20% เตือน 90–100% และ rescued 90–100% → trigger INVESTIGATE_DATA 90–100% (extreme_outlier, swapped, multivariate, unseen_category)
29. ปัญหาที่พบใน grid (ต้องแก้ใน 11c ก่อนใช้ตัวเลข): (a) ชนิดที่ต้องข้าม (category_shift/missing_drift/unseen_category บน ascore) ถูกนับเป็น trial ที่ล้มเหลว; (b) detected/preserved ของ label/concept ใช้ PSI ทางการ จึงได้ 0 ทั้งที่ section ถูก (routing 0.93/1.00); (c) ข้อมูลผิด 5% (extreme_outlier) ได้ INVESTIGATE_DRIFT 60–80% เพราะ Wasserstein ใน driftReport เตือน แต่กฎ R2 ดูแค่ PSI/CSI ทางการ; (d) ไฟล์สะอาดได้ MONITOR_CLOSELY 25% (ascore)/38% (ext) จาก KS/W fixed ชั่วคราว และ calibrated alarm รวม 30%/55% เพราะทดสอบหลายตัววัดพร้อมกัน (multiple testing) ต้อง calibrate ระดับ family
30. ext_model (Reference 300 แถว, AUC 0.615): concept_shift routing 0.70, label_shift 0.63 — ต่ำกว่า ascore เพราะ reference เล็กและโมเดลอ่อน

31. 11c (bf78150): กฎ R8b data-quality alert (% ธง > 2× Reference → INVESTIGATE_DATA แม้ drift ไม่เตือน) — extreme_outlier 5%: INVESTIGATE_DATA fixed 90% / calibrated 96.7%, INVESTIGATE_DRIFT 0% / 3.3%; mix_shift high ยังเป็น drift 100%; R8b บนไฟล์สะอาด 0%
32. Family-wise calibration (Bonferroni, 1,000 resamples) + calibrate concept/label จาก null: ไฟล์สะอาด 100 seed ascore_v1 → action ≠ CONTINUE: fixed 4% / calibrated 7% (เดิม 30%); covariate 0% / 2%; concept 3% / 3%; label 3% / 3%; ความไวยังคง concept_shift high 100%, label_shift high 100%
33. ขีดจำกัดของ concept drift เมื่อหนี้เสียน้อย (Reference 80 bad): เกณฑ์ calibrated Gini ลดลง (relative) warning n=250 = 57%, n=1000 = 27% → ตรวจได้เฉพาะการเสื่อมรุนแรง; label: bad rate เปลี่ยน ≥ 37% (n=250), ≥ 21% (n=1000)
34. ตัดสินใจออกแบบ: โหมด fixed = PSI/CSI ตามมาตรฐานอุตสาหกรรมเท่านั้น (KS/W/JS เป็น informational) — ค่าเริ่มต้น; calibrated = ทุกตัววัดแบบ family-wise (เลือกได้ต่อ Baseline). fixed ไม่ไวกับ mean_shift −10% (บันทึกเป็นข้อจำกัดใน test)

35. Power (e9650c4, ascore_v1, 30 seed): PSI ของคะแนนแบบ fixed ที่ n=100 เตือนผิด 47% (PSI มีอคติขึ้นเมื่อ n เล็ก) — calibrated 0%. mix_shift +10 จุด%: n=1000 CSI fixed 0% vs calibrated 100%; +5: n=2500 calibrated 100%; fixed CSI เริ่มจับที่ +20 (100%), +15 = 27–30%; PSI คะแนน fixed แทบไม่จับจนถึง +40. calibrated false alarm ≤10% ทุก n
36. label_shift power ต่ำ (ทั้งสองโหมดเท่ากัน): ×1.5 จับได้ 0–10%, ×2 จับได้ 20% (n=100), 33% (250), 90% (1000), 100% (2500) — ขีดจำกัดจากหนี้เสียน้อย
37. Action ถูกต้อง (fixed, e9650c4): ไฟล์สะอาด ascore 95% / ext 83%; concept_shift high 100%/90%; label_shift high 100%/93%; mix_shift high 100%; extreme_outlier 20% 100%/97%; unseen_category 97–100%; missing_drift 100%; schema_break 100%. mix_shift medium ได้ MONITOR_CLOSELY (WARNING) แม้ detect 100%
38. ช่องว่าง: ข้อมูลผิดที่ชั้น validation ตัดทิ้ง (unit_error ×100, negative, type_error, duplicate) ได้ action CONTINUE 100% แม้ตัดแถวไป 5–20% → ต้องมีกฎ R1b (rejected/duplicate สูงกว่าเกณฑ์ → INVESTIGATE_DATA)
39. variance_change medium (ascore): ได้ INVESTIGATE_DATA เพราะหางที่ยืดถูกติดธง → ความกำกวมระหว่าง drift การกระจายกับ outlier เป็นข้อจำกัดที่ต้องอภิปราย

40. 11d (c23ec95, 660d5c0): กฎ R1b (validation ตัด/เตือน > 1% → INVESTIGATE_DATA) — unit_error/negative/type_error/duplicate 5% → INVESTIGATE_DATA 100%, ไฟล์สะอาด 0%. Demo pack ใน samples/demo/ (ascore 9 ไฟล์ + 12 เดือน, ext 4 ไฟล์, new_model_auto_loan baseline AUC 0.729) ตรวจผลจริงใน README
41. Demo sequence mix_shift (12 เดือน): fixed ไม่เคยแนะนำ retrain (MONITOR_CLOSELY ที่ M10–12) vs calibrated INVESTIGATE_DRIFT M9 → CONSIDER_RETRAIN M10–12 — ภาพสาธิตข้อจำกัดของเกณฑ์อุตสาหกรรม
42. ช่องว่างที่พบ (ทำ 11e): new_model monitor_drift (ลูกค้าเสี่ยงขึ้น → bad rate ขึ้น) โหมด fixed ได้ RECALIBRATE เพราะ R5 ดูแค่ label CRITICAL — แต่ถ้าคะแนนขยับตามแล้ว bad rate ที่เพิ่มเป็นสิ่งที่โมเดลคาดไว้ ไม่ต้อง recalibrate → ต้องเทียบ bad rate จริงกับ bad rate คาดการณ์จากการกระจายคะแนน (calibration-in-the-large, ใช้ decile ของคะแนนใน Reference จึงไม่ขึ้นกับชนิดโมเดล)
43. แก้บั๊ก Vercel Blob Reference upload (HTTP 400): เพิ่ม header `x-vercel-blob-access: private` (ตั้งได้ผ่าน `BLOB_ACCESS`), แสดง snippet ของ response body ใน error (ตัดไม่เกิน 300 ตัวอักษรและ redact token), ยืนยัน Authorization header บน download/list สำหรับ private store พร้อม unit tests 14 ข้อผ่าน 100%
44. จัดการ Baseline และ Onboarding Wizard (แก้บั๊กการแสดงผล + ระบบลบ Baseline):
- แก้ป้ายสถานะ Header บน Dashboard: แสดงตามโมเดลที่เลือกใน Dropdown จริง พร้อมสถานะที่แท้จริง (`ACTIVE`, `VALIDATED (ยังไม่เปิดใช้งาน)`, `DRAFT (ยังไม่เปิดใช้งาน)`, `ยังไม่เปิดใช้งาน`) แทนการฮาร์ดโค้ด `ACTIVE`
- ปรับ Wizard ขั้นที่ 3: คง Model ID ภายในที่สร้างอัตโนมัติ (read-only) และเปิดให้ตั้งชื่ออ่านง่าย (Display Name) + คำอธิบายโมเดล โดย fallback เป็นชื่ออัตโนมัติหากไม่กรอก
- ระบบลบ Baseline: เพิ่ม API route `GET/DELETE /api/registry/models/[modelId]/versions/[version]` + ฟังก์ชัน `deleteBaselineVersion` / `getBaselineVersionImpact`; ป้องกัน built-in และไม่อนุญาตให้ลบ ACTIVE ตรงๆ (ต้อง Archive ก่อน); ตรวจสอบประวัติ monitoring/events/reviews หากมีประวัติจะแสดงจำนวนผลกระทบและเสนอ 2 ทางเลือกระหว่าง "เก็บถาวร (Archive)" กับ "ลบถาวร" (ลบทั้ง KV runs/events และ Blob reference); พร้อมหน้าต่างยืนยันที่ต้องพิมพ์ชื่อ baseline ก่อนลบ (Unit tests 5 ข้อผ่าน 100%)

## หมายเหตุสำหรับผลการทดลอง
- ผล grid 25f37be มีข้อบกพร่องการนับ (ข้อ 29) → ใช้ตัวเลขหลังแก้ 11c เท่านั้น; power_ext_model 15-00 เป็นรุ่นก่อนแก้บั๊ก ใช้ 15-08
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
- 13 + Model Portfolio / Model Profile (ไอเดียผู้ใช้ 10 พ.ย.): หน้าแรก = การ์ดโมเดล (สถานะ, ติดตามล่าสุด, trigger รอรีวิว) + การ์ด ➕ เพิ่มโมเดลใหม่; หน้าโปรไฟล์ = Model Card (Mitchell et al. 2019: ผลิตภัณฑ์, จุดประสงค์, ผู้รับผิดชอบ, ตัวแปร, AUC/Gini/KS, ข้อจำกัด) + สุขภาพโมเดล (PSI ย้อนหลัง) + เวอร์ชัน Baseline + ปุ่ม ติดตาม/Sandbox/อัปเดต Baseline/Export; ตรงกับ Multi-Product Expansion ในสไลด์เดิม และ Model Registry (MLOps slide 12)
- 13 UI Monitoring Report (Data Quality + Drift + Trigger + review) + AI สรุป/อธิบาย Drift Report และ Trigger สำหรับผู้บริหาร (ตัวเลขทั้งหมดมาจากระบบ)
- "เรื่อง Upstash" เพิ่ม (10 พ.ย.): ป้องกันเครดิต AI บน production — รหัสผ่านสำหรับฟีเจอร์ AI (env AI_ACCESS_CODE) + จำกัดจำนวนครั้งต่อวันต่อผู้ใช้ (เก็บใน Upstash) + README อธิบายการใส่ key ของตัวเอง/ใช้แบบไม่มี key (ตรงกับ Authentication & Role ในสไลด์เดิม)
- "เรื่อง Upstash": production ยังเป็น storage memory (ไม่มี env vars) — ต้องตั้ง Upstash + Vercel Blob + API key ของ AI (สำหรับ 10d/13) ก่อน demo
- 14 (ใหม่ 9 พ.ย.) ประเมินกับผู้ใช้: ผู้ทดสอบ 3–5 คน เทียบ Excel vs ระบบ (เวลา, จับความผิดปกติได้กี่จุด, สรุปถูกไหม) + SUS 10 ข้อ + จับเวลานำเข้า Baseline ใหม่ผ่านหน้าเว็บ (หลักฐานความยืดหยุ่นจากมุมผู้ใช้) — Claude เตรียมแบบฟอร์ม/โจทย์/แบบสอบถาม/ตารางคำนวณ
- ผู้ใช้ยืนยัน 9 พ.ย.: ไม่ตัด Step ใด ๆ, คงหลักความยืดหยุ่น; ประมาณเวลาที่เหลือ ~2.5–3 สัปดาห์ (ระบบ 6–8 วัน + เล่ม/สไลด์ 7–10 วัน; ร่างบท 1–3 คู่ขนานได้)
- 10d (7ee2b1d): AI provider + guardrails + eval script เสร็จ; heuristic eval 92.3% (48/52), Tricky A/C 71.4% — รอแก้ PDPA (ค่าตัวอย่างแต่ละคอลัมน์มาจากแถวเดียวกัน → ประกอบเป็นข้อมูลลูกค้าได้; ต้องสุ่มอิสระรายคอลัมน์ + ปัด 2 หลักสำคัญ + วันที่ระดับเดือน) และทำ Tricky C ให้ไม่มีชื่อบอกใบ้
- ผู้ใช้ตัดสินใจ 10 พ.ย.: ใช้ Claude API จริง (ประมาณการค่าใช้จ่ายทั้ง IS หลักร้อยบาท) — เงื่อนไข: แก้ PDPA ก่อน, ตั้ง spend limit, key อยู่ใน .env.local เท่านั้น (production ใส่ใน Vercel env ตอนทำเรื่อง Upstash)
- 10d fixes: สคริปต์ไม่โหลด .env.local (ต้อง loadEnvConfig), DEFAULT_AI_MODEL เก่า → claude-sonnet-5-5, tool_choice แบบบังคับไม่รองรับ → auto + parse tool_use/text; สคริปต์วัดผลต้องหยุดทันทีเมื่อ AI ใช้ไม่ได้ (ห้าม fallback เงียบ)
- ตัดสินใจหลังวัดผล: ค่าเริ่มต้นในหน้าเว็บควรเป็น AI เป็นหลัก + กฎเป็นความเห็นที่สองและ fallback (ไม่ใช่ merge ตาม confidence) — เป็นการปรับหลังเห็นผล ต้องรายงานแยก
- (เดิม) รอ: วัดผล ai / combined บน held-out ด้วย API key จริง (AI ตามที่ออกแบบไว้ก่อน = ผลหลัก; ถ้าเพิ่มสถิติความสัมพันธ์ระหว่างคอลัมน์ให้ AI ภายหลัง ต้องรายงานแยกเป็น post-hoc)
- ยังไม่ทราบวันนำเสนอ Final
- เขียนเล่ม บทที่ 1–5 + สไลด์ Final

## Step 10c+ / Baseline Registry & Deletion Capabilities
- **Audit Log ของการลบ (Deletion Audit Log)**:
  - เพิ่ม `DeletionAuditEntry` ใน `lib/types.ts` และจัดเก็บใน KV key `registry:deletion_audit` (แยกต่างหาก ข้อมูลอยู่รอดหลังโมเดล/เวอร์ชันถูกลบถาวร)
  - ห้ามเก็บข้อมูลลูกค้า บันทึกเฉพาะ: modelId, version, action (ARCHIVE / DELETE / DELETE_MODEL), previousStatus, clearedRunsCount, clearedEventsCount, deletedReferenceId, operator, timestamp
  - มี API `GET /api/registry/audit` และ UI แสดงประวัติการลบและเก็บถาวรแบบ accordion ยุบ/ขยายได้ใน Baseline Registry
- **การลบทั้งโมเดล (Delete Entire Model)**:
  - ฟังก์ชัน `deleteRegistryModel` ใน `lib/storage/repositories.ts` และ `DELETE /api/registry/models/[modelId]`
  - Guards: ห้ามลบ built-in model, ห้ามลบ default model (ต้องเปลี่ยน default ก่อน), ห้ามลบโมเดลที่มี ACTIVE version
  - เมื่อลบเวอร์ชันสุดท้าย มีตัวเลือก `deleteModelIfEmpty` ให้ผู้ใช้เลือกได้ว่าจะลบตัวโมเดลทิ้งด้วยหรือไม่
  - ยืนยันการลบโมเดลด้วยการพิมพ์ชื่อ modelId
- **การแก้ไข Baseline (Edit Baseline Metadata)**:
  - ฟังก์ชัน `updateBaselineVersion` และ `PATCH /api/registry/models/[modelId]/versions/[version]`
  - แก้ไขชื่อที่แสดง (name) และคำอธิบาย (description) ได้
  - หากมีการแก้ไขโครงสร้าง schema จะไม่อนุญาตบนสถานะ ACTIVE และหากเป็น VALIDATED จะปรับกลับเป็น DRAFT อัตโนมัติเพื่อบังคับ re-validate
- **Onboarding Wizard Stepper Navigation**:
  - Stepper ด้านบนของ Baseline Onboarding Wizard คลิกเพื่อย้อนกลับหรือข้ามไปยังขั้นตอนที่ปลดล็อกแล้วได้ทันที
- **Tests**:
  - เพิ่ม `tests/baseline-delete.test.ts` (9/9 tests pass)
  - `tests/no-hardcode.test.ts` (pass 0 violations)
  - `npx tsc --noEmit` ผ่าน 0 errors
