"""Realistic synthetic Thai personal cash-loan data: baseline + 6 monthly monitoring files with known scenarios."""
import numpy as np, pandas as pd, os, json, sys
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(20261114)

REGIONS = ['กรุงเทพฯและปริมณฑล', 'ภาคกลาง', 'ภาคตะวันออก', 'ภาคเหนือ', 'ภาคตะวันออกเฉียงเหนือ', 'ภาคใต้']
REG_P = [0.38, 0.14, 0.10, 0.12, 0.16, 0.10]
CHANNELS = ['สาขา', 'Mobile App', 'Telesales']
OCC = ['พนักงานบริษัท', 'ข้าราชการ/รัฐวิสาหกิจ', 'เจ้าของกิจการ', 'อาชีพอิสระ', 'พนักงานรายวัน']
OCC_INC = {'พนักงานบริษัท': 26000, 'ข้าราชการ/รัฐวิสาหกิจ': 30000, 'เจ้าของกิจการ': 38000, 'อาชีพอิสระ': 22000, 'พนักงานรายวัน': 16500}
OCC_RISK = {'พนักงานบริษัท': 0.0, 'ข้าราชการ/รัฐวิสาหกิจ': -0.7, 'เจ้าของกิจการ': 0.25, 'อาชีพอิสระ': 0.45, 'พนักงานรายวัน': 0.6}
RES = ['บ้านตนเอง', 'เช่า', 'อยู่กับครอบครัว']
RES_RISK = {'บ้านตนเอง': -0.3, 'เช่า': 0.25, 'อยู่กับครอบครัว': 0.0}


def population(n, channel_p=(0.55, 0.30, 0.15), young_shift=0.0, occ_p=(0.48, 0.14, 0.10, 0.16, 0.12), inc_mult=1.0, inq_add=0.0):
    ch = rng.choice(CHANNELS, n, p=channel_p)
    occ = rng.choice(OCC, n, p=occ_p)
    base_age = rng.normal(37, 9, n) - young_shift * (ch == 'Mobile App') * 6
    age = np.clip(np.round(base_age), 21, 60).astype(int)
    emp = np.clip(np.round((age - 21) * rng.uniform(0.15, 0.8, n)), 0, 35).astype(int)
    inc_med = np.array([OCC_INC[o] for o in occ]) * (1 + 0.012 * (age - 35))
    inc = np.exp(np.log(inc_med) + rng.normal(0, 0.38, n)) * inc_mult
    inc = np.clip(np.round(inc / 100) * 100, 15000, 400000)
    res = np.where(age > 40, rng.choice(RES, n, p=[0.6, 0.25, 0.15]), rng.choice(RES, n, p=[0.25, 0.35, 0.40]))
    reg = rng.choice(REGIONS, n, p=REG_P)
    term = rng.choice([12, 24, 36, 48, 60], n, p=[0.08, 0.2, 0.32, 0.22, 0.18])
    loan = np.clip(np.round(inc * rng.uniform(1.5, 5.0, n) / 1000) * 1000, 10000, 500000)
    ex_debt = np.round(inc * np.clip(rng.beta(2, 6, n), 0, 0.7) / 100) * 100
    inst = loan * (0.24 / 12) / (1 - (1 + 0.24 / 12) ** (-term))
    dti = np.round((ex_debt + inst) / inc, 3)
    inq = rng.poisson(1.2 + inq_add + 0.8 * (ch == 'Mobile App'), n)
    dpd = rng.choice([0, 0, 0, 0, 0, 0, 0, 5, 15, 30, 45, 60], n)
    util = np.round(np.clip(rng.beta(2, 3, n) * 100 + dpd * 0.3, 0, 100), 1)
    df = pd.DataFrame({
        'channel': ch, 'branch_region': reg, 'age': age, 'occupation': occ, 'employment_years': emp,
        'monthly_income': inc.astype(int), 'residence_type': res, 'loan_amount': loan.astype(int), 'term_months': term,
        'existing_debt_payment': ex_debt.astype(int), 'dti': dti, 'ncb_inquiries_6m': inq,
        'ncb_max_dpd_12m': dpd, 'credit_util_pct': util,
    })
    return df


def true_logit(df, concept=False):
    occ_r = df['occupation'].map(OCC_RISK).values
    if concept:  # economic shock: informal workers much riskier, income protects less, DTI matters more
        occ_r = occ_r + df['occupation'].map({'อาชีพอิสระ': 0.9, 'พนักงานรายวัน': 1.0, 'เจ้าของกิจการ': 0.6}).fillna(0).values
    inc_coef = -0.25 if concept else -0.55
    z = (-2.65 + inc_coef * (np.log(df['monthly_income']) - np.log(25000)) + 1.6 * (df['dti'] - 0.45)
         + 0.22 * df['ncb_inquiries_6m'] + 0.025 * df['ncb_max_dpd_12m'] + 0.012 * (df['credit_util_pct'] - 40)
         - 0.025 * (df['age'] - 37) - 0.03 * df['employment_years'] + occ_r + df['residence_type'].map(RES_RISK).values)
    return z


def draw_default(df, concept=False):
    p = 1 / (1 + np.exp(-true_logit(df, concept)))
    return (rng.uniform(size=len(df)) < p).astype(int)



NUMBINS = {
 'age': [28, 35, 45], 'employment_years': [2, 7], 'monthly_income': [18000, 25000, 35000],
 'dti': [0.35, 0.50, 0.65], 'ncb_inquiries_6m': [0, 2], 'ncb_max_dpd_12m': [0, 15], 'credit_util_pct': [30, 60]}
CATPOOLS = {
 'occupation': [['ข้าราชการ/รัฐวิสาหกิจ'], ['พนักงานบริษัท'], ['เจ้าของกิจการ', 'อาชีพอิสระ'], ['พนักงานรายวัน']],
 'residence_type': [['บ้านตนเอง'], ['อยู่กับครอบครัว'], ['เช่า']]}


def bin_index(df):
    cols = {}
    for v, cuts in NUMBINS.items():
        cols[v] = np.searchsorted(np.array(cuts), df[v].astype(float).values, side='left')  # upper bound inclusive
    for v, pools in CATPOOLS.items():
        m = {c: i for i, p in enumerate(pools) for c in p}
        cols[v] = df[v].map(m).fillna(-1).astype(int).values
    return cols


def onehot(df):
    idx = bin_index(df); parts = []; names = []
    for v in list(NUMBINS) + list(CATPOOLS):
        k = len(NUMBINS[v]) + 1 if v in NUMBINS else len(CATPOOLS[v])
        for i in range(k):
            parts.append((idx[v] == i).astype(float)); names.append((v, i))
    return np.column_stack(parts), names


def build_scorecard(df):
    X, names = onehot(df)
    lr = LogisticRegression(max_iter=3000, C=0.3).fit(X, df['default_12m'])
    pts = {n: -28.85 * c for n, c in zip(names, lr.coef_[0])}
    base_pts = 487.12 - 28.85 * (-lr.intercept_[0]) * -1 if False else 487.12 + 28.85 * (-lr.intercept_[0]) * 1
    out = {}
    for v in list(NUMBINS) + list(CATPOOLS):
        ks = [i for (vv, i) in names if vv == v]
        mn = min(pts[(v, i)] for i in ks)
        for i in ks:
            out[(v, i)] = int(round(pts[(v, i)] - mn))
        base_pts += mn
    return {'base': int(round(base_pts)), 'pts': out}


def score_table(df, sc):
    idx = bin_index(df); s = np.full(len(df), sc['base'], dtype=int)
    for v in list(NUMBINS) + list(CATPOOLS):
        s = s + np.array([sc['pts'].get((v, int(i)), 0) for i in idx[v]])
    return s


# ── Baseline (development sample) ──
base = population(5000)
base['default_12m'] = draw_default(base)
SC = build_scorecard(base)


def score(df):
    return score_table(df, SC)


def finalize(df, start, end, prefix):
    n = len(df)
    dates = pd.to_datetime(rng.integers(pd.Timestamp(start).value // 10**9, pd.Timestamp(end).value // 10**9, n), unit='s').strftime('%Y-%m-%d')
    out = pd.DataFrame({'app_id': [f'{prefix}{i:06d}' for i in range(1, n + 1)], 'app_date': dates})
    out = pd.concat([out, df.reset_index(drop=True)], axis=1)
    out = out.sort_values('app_date').reset_index(drop=True)
    return out


base['credit_score'] = score(base)
auc_base = roc_auc_score(base['default_12m'], -base['credit_score'])
ORDER = ['app_id', 'app_date', 'branch_region', 'channel', 'age', 'occupation', 'employment_years', 'monthly_income', 'residence_type',
         'loan_amount', 'term_months', 'existing_debt_payment', 'dti', 'ncb_inquiries_6m', 'ncb_max_dpd_12m', 'credit_util_pct', 'credit_score', 'default_12m']
b = finalize(base, '2024-01-01', '2024-12-31', 'DEV24')[ORDER]
b.to_csv(f'{OUT}/baseline_cashloan_v2_2024.csv', index=False)

summary = {'baseline': {'rows': len(b), 'bad_rate': round(b['default_12m'].mean(), 4), 'auc': round(auc_base, 3)}}


def month(name, start, end, df, concept=False, tweak=None):
    df = df.copy()
    df['credit_score'] = score(df)
    df['default_12m'] = draw_default(df, concept)
    m = finalize(df, start, end, 'APP' + start[2:4] + start[5:7])[ORDER]
    truth = {}
    if tweak:
        m, truth = tweak(m)
    m.to_csv(f'{OUT}/{name}.csv', index=False)
    valid = m['credit_score'].notna()
    summary[name] = {'rows': len(m), 'bad_rate': round(m['default_12m'].mean(), 4),
                     'auc': round(roc_auc_score(m.loc[valid, 'default_12m'], -m.loc[valid, 'credit_score']), 3),
                     'mean_score': round(m['credit_score'].mean(), 1), **truth}


month('m01_v2_2025-07_ปกติ', '2025-07-01', '2025-07-31', population(1200))
month('m02_v2_2025-08_ปกติ', '2025-08-01', '2025-08-31', population(1200))


def incident(m):
    m = m.copy()
    ne = m.index[(m['branch_region'] == 'ภาคตะวันออกเฉียงเหนือ')]
    k = ne[rng.uniform(size=len(ne)) < 0.55]  # a branch batch exported income in thousands
    m['monthly_income'] = m['monthly_income'].astype(object)
    m.loc[k, 'monthly_income'] = (m.loc[k, 'monthly_income'].astype(float) / 1000).round(1)
    typo = m.index[(m['occupation'] == 'พนักงานบริษัท') & (rng.uniform(size=len(m)) < 0.08)]
    m.loc[typo, 'occupation'] = 'พนง.บริษัท'
    miss = m.index[rng.uniform(size=len(m)) < 0.06]
    m['credit_util_pct'] = m['credit_util_pct'].astype(object)
    m.loc[miss, 'credit_util_pct'] = ''
    return m, {'injected_income_in_thousands_rows': int(len(k)), 'injected_unseen_occupation_rows': int(len(typo)), 'injected_missing_util_rows': int(len(miss))}


month('m03_v2_2025-09_ระบบต้นทางมีปัญหา', '2025-09-01', '2025-09-30', population(1200), tweak=incident)


def dupes(m):
    d = m.sample(frac=0.03, random_state=7)
    m = pd.concat([m, d]).sort_values('app_date').reset_index(drop=True)
    return m, {'injected_duplicate_rows': int(len(d))}


month('m04_v2_2025-10_ส่งข้อมูลซ้ำ', '2025-10-01', '2025-10-31', population(1200), tweak=dupes)
month('m05_v2_2025-11_แคมเปญMobileApp', '2025-11-01', '2025-11-30',
      population(1300, channel_p=(0.25, 0.62, 0.13), young_shift=1.0, occ_p=(0.42, 0.08, 0.10, 0.24, 0.16), inc_mult=0.9, inq_add=0.6))
month('m06_v2_2025-12_เศรษฐกิจชะลอตัว', '2025-12-01', '2025-12-31', population(1200), concept=True)


rows = [('base_points', '', '', '', '', '', SC['base'])]
for v, cuts in NUMBINS.items():
    for i in range(len(cuts) + 1):
        lo = '' if i == 0 else cuts[i - 1]; up = '' if i == len(cuts) else cuts[i]
        rows.append((v, 'numeric', f'{v}_{i+1}', lo, up, '', SC['pts'][(v, i)]))
for v, pools in CATPOOLS.items():
    for i, p in enumerate(pools):
        rows.append((v, 'categorical', f'{v}_{i+1}', '', '', '|'.join(p), SC['pts'][(v, i)]))
pd.DataFrame(rows, columns=['variable', 'type', 'pool_id', 'lower', 'upper', 'categories', 'points']).to_csv(f'{OUT}/model_table_cashloan.csv', index=False)
summary['scorecard_base_points'] = SC['base']
json.dump(summary, open(f'{OUT}/_summary.json', 'w'), ensure_ascii=False, indent=2)
print(json.dumps(summary, ensure_ascii=False, indent=1))
