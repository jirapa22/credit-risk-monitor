"""
Build the frozen Reference Dataset used for every PSI/CSI comparison.

Source : personal_loan_mock_data.xlsx  (sheet: loan_data)
Filter : approval_status == 'อนุมัติ'  → development population (n = 855)
Output : data/reference/ascore_v1_dev855.json

The train/test split used in ascore_model_report.xlsx was a random split whose
seed is not recorded, so it cannot be reproduced row-by-row. Train + Test
together equal the full approved population (verified: bin counts in the
"Scorecard" sheet + "PSI & CSI Baseline" sheet sum to the counts below), so
the full development population is used as the reference.

Run once (or whenever the reference must be re-issued with a NEW id/version):
    python3 scripts/build_reference_dataset.py
Never overwrite an existing reference id — create a new version instead,
otherwise past monitoring runs lose comparability.
"""
import datetime
import hashlib
import json
import os
import sys

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "personal_loan_mock_data.xlsx")
REF_ID = "ascore_v1_dev855"
OUT = os.path.join(ROOT, "data", "reference", f"{REF_ID}.json")
COLUMNS = ["customer_id", "application_date", "monthly_income", "loan_amount", "dti_ratio", "default_flag"]

if os.path.exists(OUT) and "--force" not in sys.argv:
    sys.exit(f"{OUT} already exists. Reference datasets are immutable; use a new REF_ID or --force.")

ws = openpyxl.load_workbook(SRC, data_only=True)["loan_data"]
rows = list(ws.iter_rows(values_only=True))
header = list(rows[0])
records = []
for r in rows[1:]:
    d = dict(zip(header, r))
    if d["approval_status"] != "อนุมัติ":
        continue
    records.append({
        "customer_id": str(d["customer_id"]),
        "application_date": str(d["application_date"])[:10],
        "monthly_income": float(d["monthly_income"]),
        "loan_amount": float(d["loan_amount"]),
        "dti_ratio": float(d["dti_ratio"]),
        "default_flag": int(d["default_flag"]),
    })
records.sort(key=lambda x: x["customer_id"])

payload_rows = json.dumps(records, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
sha = hashlib.sha256(payload_rows.encode("utf-8")).hexdigest()
dates = sorted(r["application_date"] for r in records)
bad = sum(r["default_flag"] for r in records)

out = {
    "meta": {
        "referenceId": REF_ID,
        "version": "1.0.0",
        "modelId": "ascore_v1",
        "description": "Development population (approved accounts) — frozen reference for PSI/CSI",
        "source": "personal_loan_mock_data.xlsx / loan_data / approval_status = อนุมัติ",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rowCount": len(records),
        "badCount": bad,
        "badRate": round(bad / len(records), 4),
        "periodStart": dates[0],
        "periodEnd": dates[-1],
        "columns": COLUMNS,
        "sha256": sha,
    },
    "rows": records,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
print(f"wrote {OUT}: n={len(records)} bad={bad} sha256={sha[:12]}")
