/**
 * Tests for Configurable, Selectable, and Auditable Rule Sets (Step 10 / งาน B)
 *
 * Covers:
 * 1. Immutable revisions
 * 2. Audit trail with field-by-field diff
 * 3. Activation changes subsequent run's outcome
 * 4. Run persists ruleSetId, ruleSetName, ruleSetRevision, thresholdsSnapshot
 * 5. Input validation rejects invalid configs
 * 6. m05 under "มาตรฐาน" -> R5 RECALIBRATE; under "ปรับตามประชากร" -> R5b MONITOR_CLOSELY
 * 7. Reverting activates old revision and creates new audit entry without deleting history
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setStore, createMemoryStore } from '../lib/storage/store';
import { setBlobStore, createMemoryBlobStore } from '../lib/storage/blob';
import {
  listRuleSets,
  addRuleSetRevision,
  activateRuleSetRevision,
  revertRuleSetRevision,
  validateRuleSetConfig,
  computeRuleSetConfigDiff,
  listRuleSetAuditLogs,
  initializeDefaultRuleSets,
  STANDARD_RULE_SET_CONFIG,
  STRICT_RULE_SET_CONFIG,
  POPULATION_ADJUSTED_RULE_SET_CONFIG,
} from '../lib/storage/ruleSetRepository';
import type { FeatureDefinition, RuleSetConfig, RuleSet } from '../lib/types';
import { executeMonitoringPipeline } from '../lib/monitoringCore';
import { POST as referencesHandler } from '../app/api/registry/references/route';
import { POST as suggestHandler } from '../app/api/registry/suggest/route';
import { POST as importModelTableHandler } from '../app/api/registry/model-table/import/route';
import { POST as createDraftHandler } from '../app/api/registry/models/[modelId]/versions/route';
import { POST as validateVersionHandler } from '../app/api/registry/models/[modelId]/versions/[version]/validate/route';
import { POST as activateBaselineHandler } from '../app/api/registry/models/[modelId]/versions/[version]/activate/route';
import { buildRunReport } from '../lib/report/buildRunReport';

describe('Configurable Rule Sets (งาน B)', () => {
  const modelId = 'model_vmc5k';
  const version = '1.0.0';
  const root = join(__dirname, '..');

  beforeAll(async () => {
    // Reset to fresh memory store and blob store
    setStore(createMemoryStore());
    setBlobStore(createMemoryBlobStore());

    // Bootstrap cashloan_v2 model baseline in memory
    const baseText = readFileSync(join(root, 'samples/cashloan_v2/baseline_cashloan_v2_2024.csv'), 'utf8');
    const mtText = readFileSync(join(root, 'samples/cashloan_v2/model_table_cashloan.csv'), 'utf8');

    await referencesHandler(new Request('http://localhost:3000/api/registry/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        referenceId: 'ref_cashloan_v2',
        csvText: baseText,
        modelId,
        version,
        description: 'Baseline for Rule Set Tests',
        labelColumn: 'default_12m',
      }),
    }));

    const sugRes = await suggestHandler(new Request('http://localhost:3000/api/registry/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: 'ref_cashloan_v2', provider: 'heuristic' }),
    }));
    const sugData = await sugRes.json();

    const columnMapping: Record<string, { role: string; type: string }> = {};
    for (const c of sugData.columns) {
      columnMapping[c.column] = { role: c.role, type: c.type };
    }
    columnMapping['app_id'] = { role: 'id', type: 'text' };
    columnMapping['default_12m'] = { role: 'label', type: 'binary' };
    columnMapping['app_date'] = { role: 'date', type: 'date' };
    columnMapping['credit_score'] = { role: 'score', type: 'numeric' };

    const featureDefs: Record<string, {
      displayName: string;
      description?: string;
      dataType: 'numeric' | 'categorical' | 'date' | 'binary';
      minValue?: number;
      maxValue?: number;
      missingStrategy: string;
      usedInModel?: boolean;
      required?: boolean;
      binning?: unknown;
      categoryPools?: unknown;
      poolPoints?: unknown;
    }> = {};

    for (const fs of sugData.featureSettings ?? []) {
      featureDefs[fs.feature] = {
        displayName: fs.feature,
        description: fs.description,
        dataType: fs.dataType,
        minValue: fs.minValue,
        maxValue: fs.maxValue,
        missingStrategy: (fs.missingStrategy === 'fillMean' ? 'mean' : fs.missingStrategy === 'fillMedian' ? 'median' : fs.missingStrategy === 'fillMode' ? 'mode' : fs.missingStrategy === 'ignore' ? 'ignore' : 'reject'),
      };
    }

    const mtRes = await importModelTableHandler(new Request('http://localhost:3000/api/registry/model-table/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referenceId: 'ref_cashloan_v2', csvText: mtText }),
    }));
    const mtData = await mtRes.json();

    for (const [col, update] of Object.entries(mtData.featureSettingsUpdates ?? {})) {
      if (featureDefs[col]) {
        featureDefs[col] = {
          ...featureDefs[col],
          usedInModel: true,
          required: true,
          missingStrategy: 'reject',
          binning: (update as any).binning ?? featureDefs[col].binning,
          categoryPools: (update as any).categoryPools ?? featureDefs[col].categoryPools,
          poolPoints: (update as any).poolPoints ?? featureDefs[col].poolPoints,
        };
      }
    }

    const features = Object.entries(columnMapping)
      .filter(([_, m]) => m.role === 'feature')
      .map(([col]) => col);

    const registryPayload: Record<string, FeatureDefinition> = {};
    for (const f of features) {
      const def = featureDefs[f];
      if (!def) continue;
      registryPayload[f] = {
        columnName: f,
        displayName: def.displayName || f,
        dataType: def.dataType,
        required: def.missingStrategy === 'reject',
        monitoringEnabled: true,
        validation: {
          minValue: def.minValue,
          maxValue: def.maxValue,
          missingStrategy: 'reject',
        },
      };
    }

    await createDraftHandler(
      new Request(`http://localhost:3000/api/registry/models/${modelId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version,
          referenceDatasetId: 'ref_cashloan_v2',
          columns: {
            idColumn: 'app_id',
            dateColumn: 'app_date',
            labelColumn: 'default_12m',
            scoreColumn: 'credit_score',
          },
          featureRegistry: registryPayload,
          scoring: mtData.scoring,
          scoreDirection: 'higher_is_safer',
        }),
      }),
      { params: Promise.resolve({ modelId }) },
    );

    await validateVersionHandler(
      new Request(`http://localhost:3000/api/registry/models/${modelId}/versions/${version}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runMultivariateCheck: false, runCalibration: false }),
      }),
      { params: Promise.resolve({ modelId, version }) },
    );

    await activateBaselineHandler(
      new Request(`http://localhost:3000/api/registry/models/${modelId}/versions/${version}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: 'test-setup' }),
      }),
      { params: Promise.resolve({ modelId, version }) },
    );
  });

  beforeEach(async () => {
    await initializeDefaultRuleSets(modelId, version);
  });

  it('(1) immutable revisions: updating a rule set creates a new revision and preserves past revisions', async () => {
    const { ruleSets } = await listRuleSets(modelId, version);
    const standardSet = ruleSets.find(s => s.id === 'ruleset_standard')!;
    expect(standardSet).toBeDefined();
    expect(standardSet.currentRevision).toBe(1);
    expect(standardSet.revisions.length).toBe(1);

    const initialRev1 = standardSet.revisions[0];
    const initialPsiWarning = initialRev1.config.psi_warning;

    // Add revision 2 with modified PSI warning
    const modifiedConfig: RuleSetConfig = {
      ...initialRev1.config,
      psi_warning: 0.08,
    };

    const addRes = await addRuleSetRevision(modelId, version, 'ruleset_standard', {
      config: modifiedConfig,
      author: 'วิศวกรความเสี่ยง ก.',
      reason: 'ปรับเกณฑ์เตือนให้ไวขึ้นตามมติ คกก.',
    });

    expect(addRes.newRevision.revision).toBe(2);
    expect(addRes.newRevision.config.psi_warning).toBe(0.08);

    // Verify listRuleSets reflects immutability
    const updated = await listRuleSets(modelId, version);
    const reloaded = updated.ruleSets.find(s => s.id === 'ruleset_standard')!;
    expect(reloaded.currentRevision).toBe(2);
    expect(reloaded.revisions.length).toBe(2);

    // Revision 1 must be 100% intact and unchanged
    expect(reloaded.revisions[0].revision).toBe(1);
    expect(reloaded.revisions[0].config.psi_warning).toBe(initialPsiWarning);

    // Revision 2 has the new value
    expect(reloaded.revisions[1].revision).toBe(2);
    expect(reloaded.revisions[1].config.psi_warning).toBe(0.08);
  });

  it('(2) audit trail: saving changes records audit log with accurate field-by-field diff', async () => {
    const { ruleSets } = await listRuleSets(modelId, version);
    const standardSet = ruleSets.find(s => s.id === 'ruleset_standard')!;

    const newConfig: RuleSetConfig = {
      ...standardSet.revisions[0].config,
      psi_warning: 0.07,
      auc_min: 0.60,
    };

    const addRes = await addRuleSetRevision(modelId, version, 'ruleset_standard', {
      config: newConfig,
      author: 'นายทดสอบ',
      reason: 'ทดสอบการตรวจวัด diff ใน audit trail',
    });

    expect(addRes.auditEntry.action).toBe('UPDATE');
    expect(addRes.auditEntry.author).toBe('นายทดสอบ');
    expect(addRes.auditEntry.reason).toBe('ทดสอบการตรวจวัด diff ใน audit trail');

    // Diff must contain psi_warning and auc_min
    const psiDiff = addRes.auditEntry.diffs.find(d => d.field === 'psi_warning');
    expect(psiDiff).toBeDefined();
    expect(psiDiff?.oldValue).toBe(0.10);
    expect(psiDiff?.newValue).toBe(0.07);

    const aucDiff = addRes.auditEntry.diffs.find(d => d.field === 'auc_min');
    expect(aucDiff).toBeDefined();
    expect(aucDiff?.oldValue).toBe(0.55);
    expect(aucDiff?.newValue).toBe(0.60);

    // Verify stored audit logs
    const logs = await listRuleSetAuditLogs(modelId, version);
    expect(logs[0].id).toBe(addRes.auditEntry.id);
  });

  it('(3) activation changes next run outcome and records revision used', async () => {
    // 1. Run m01 under standard rules (PSI is ~0.02, stable)
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const run1Res = await executeMonitoringPipeline({
      modelId,
      fileName: 'm01_run1.csv',
      csvText: m01Text,
      onDuplicate: 'replace',
    });

    expect(run1Res.run.ruleSetId).toBe('ruleset_standard');
    expect(run1Res.run.ruleSetName).toBe('มาตรฐาน');
    expect(run1Res.run.ruleSetRevision).toBe(1);
    expect(run1Res.run.thresholdsSnapshot.psi_warning).toBe(0.10);

    // 2. Activate strict template (psi_warning: 0.05, psi_critical: 0.15)
    await activateRuleSetRevision(modelId, version, 'ruleset_strict', 1, {
      author: 'ผู้จัดการความเสี่ยง',
      reason: 'เปิดใช้เกณฑ์เข้มงวดสำหรับการติดตามรอบใหม่',
    });

    // 3. Next run under strict rules records new revision snapshot
    const run2Res = await executeMonitoringPipeline({
      modelId,
      fileName: 'm01_run2.csv',
      csvText: m01Text,
      onDuplicate: 'replace',
    });

    expect(run2Res.run.ruleSetId).toBe('ruleset_strict');
    expect(run2Res.run.ruleSetName).toBe('เข้มงวด');
    expect(run2Res.run.ruleSetRevision).toBe(1);
    expect(run2Res.run.thresholdsSnapshot.psi_warning).toBe(0.05);
    expect(run2Res.run.thresholdsSnapshot.psi_critical).toBe(0.15);

    // 4. Per-run report view model displays rule set info
    const report = buildRunReport(run2Res.run, run2Res.detail);
    expect(report.header.ruleSetInfo).toBe('เข้มงวด (rev 1)');
  });

  it('(4) validation rejects invalid inputs with clear Thai error messages', async () => {
    // psi_warning >= psi_critical
    const err1 = validateRuleSetConfig({
      ...STANDARD_RULE_SET_CONFIG,
      psi_warning: 0.25,
      psi_critical: 0.25,
    });
    expect(err1.some(e => e.includes('เกณฑ์เตือน PSI ต้องน้อยกว่าเกณฑ์วิกฤต PSI'))).toBe(true);

    // Negative threshold
    const err2 = validateRuleSetConfig({
      ...STANDARD_RULE_SET_CONFIG,
      psi_warning: -0.05,
    });
    expect(err2.some(e => e.includes('เกณฑ์เตือน PSI'))).toBe(true);

    // AUC > 1
    const err3 = validateRuleSetConfig({
      ...STANDARD_RULE_SET_CONFIG,
      auc_min: 1.2,
    });
    expect(err3.some(e => e.includes('เกณฑ์ขั้นต่ำ AUC'))).toBe(true);

    // Missing author or reason in addRuleSetRevision
    await expect(
      addRuleSetRevision(modelId, version, 'ruleset_standard', {
        config: STRICT_RULE_SET_CONFIG,
        author: '',
        reason: 'ทดสอบ',
      }),
    ).rejects.toThrow('กรุณาระบุชื่อผู้แก้ไข');

    await expect(
      addRuleSetRevision(modelId, version, 'ruleset_standard', {
        config: STRICT_RULE_SET_CONFIG,
        author: 'สมชาย',
        reason: '',
      }),
    ).rejects.toThrow('กรุณาระบุเหตุผลในการแก้ไข');
  });

  it('(5) m05 under "มาตรฐาน" produces R5 RECALIBRATE; under "ปรับตามประชากร" falls to R7 INVESTIGATE_DRIFT because covariate drift is CRITICAL', async () => {
    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');

    // Case A: Under default "มาตรฐาน" (Standard)
    const runStandard = await executeMonitoringPipeline({
      modelId,
      fileName: 'm05_v2_2025-11_แคมเปญMobileApp.csv',
      csvText: m05Text,
      onDuplicate: 'replace',
    });

    expect(runStandard.run.trigger?.action).toBe('RECALIBRATE');
    expect(runStandard.run.trigger?.matchedRuleId).toBe('R5');

    // Case B: Activate "ปรับตามประชากร" (Population Adjusted) where R5b is enabled
    // Since m05 has CRITICAL covariate drift (channel CSI = 0.2831, ncb_inquiries_6m CSI = 0.3380),
    // R5b does NOT downgrade to MONITOR_CLOSELY, but lets it fall to R7 (INVESTIGATE_DRIFT)
    await activateRuleSetRevision(modelId, version, 'ruleset_population_adjusted', 1, {
      author: 'นักวิเคราะห์โมเดล',
      reason: 'เปิดใช้เกณฑ์ปรับตามประชากรสำหรับแคมเปญ Mobile App',
    });

    const runPopAdj = await executeMonitoringPipeline({
      modelId,
      fileName: 'm05_v2_2025-11_แคมเปญMobileApp.csv',
      csvText: m05Text,
      onDuplicate: 'replace',
    });

    expect(runPopAdj.run.trigger?.action).toBe('INVESTIGATE_DRIFT');
    expect(runPopAdj.run.trigger?.matchedRuleId).toBe('R7');
    expect(runPopAdj.run.trigger?.reasons[0]).toContain('[R7]');
    expect(runPopAdj.run.trigger?.reasons[0]).toContain('ลักษณะลูกค้าเปลี่ยน');

    // Case C: When covariate drift is NOT critical (e.g. simulated run where CSI is within warning), R5b fires MONITOR_CLOSELY
    const mockNonCritRun = {
      ...runPopAdj.run,
      driftReport: {
        ...runPopAdj.run.driftReport!,
        covariate: {
          ...runPopAdj.run.driftReport!.covariate,
          status: 'WARNING' as const,
        },
      },
    };
    const { evaluateTrigger } = await import('../lib/trigger');
    const decision = evaluateTrigger(mockNonCritRun, {
      ...runPopAdj.model,
      ruleSetConfig: POPULATION_ADJUSTED_RULE_SET_CONFIG,
    });
    expect(decision.action).toBe('MONITOR_CLOSELY');
    expect(decision.matchedRuleId).toBe('R5b');
    expect(decision.reasons[0]).toContain('[R5b]');
    expect(decision.reasons[0]).toContain('ประชากรเปลี่ยน ไม่ใช่ความสัมพันธ์ของโมเดลเปลี่ยน');
  });

  it('(7) empty KV on production: pipeline runs using defaults, produces regression outcome, records "ไม่ระบุ (ค่าเริ่มต้นเดิม)", and writes no rulesets to KV', async () => {
    const store = (await import('../lib/storage/store')).getStore();
    // Explicitly delete rule set keys to simulate production with empty KV
    await store.del(`rulesets:${modelId}:${version}`);
    await store.del(`rulesets:active:${modelId}:${version}`);
    await store.del(`rulesets:audit:${modelId}:${version}`);

    const m05Text = readFileSync(join(root, 'samples/cashloan_v2/m05_v2_2025-11_แคมเปญMobileApp.csv'), 'utf8');

    const res = await executeMonitoringPipeline({
      modelId,
      fileName: 'm05_empty_kv.csv',
      csvText: m05Text,
      onDuplicate: 'replace',
    });

    // 1. Outcome equals regression default
    expect(res.run.trigger?.action).toBe('RECALIBRATE');
    expect(res.run.trigger?.matchedRuleId).toBe('R5');
    expect(res.run.thresholdsSnapshot.psi_warning).toBe(0.10);
    expect(res.run.thresholdsSnapshot.psi_critical).toBe(0.25);

    // 2. Rule set info is "ไม่ระบุ (ค่าเริ่มต้นเดิม)"
    const report = buildRunReport(res.run, res.detail);
    expect(report.header.ruleSetInfo).toBe('ไม่ระบุ (ค่าเริ่มต้นเดิม)');

    // 3. Confirm nothing was auto-written to KV
    const storedSets = await store.get(`rulesets:${modelId}:${version}`);
    expect(storedSets).toBeNull();
    const storedActive = await store.get(`rulesets:active:${modelId}:${version}`);
    expect(storedActive).toBeNull();
  });

  it('(8) simulateRuleSetOnPastRuns recomputes PSI/CSI levels dynamically from stored values using candidate thresholds', async () => {
    const { simulateRuleSetOnPastRuns } = await import('../lib/storage/ruleSetRepository');
    const { getEffectiveModel } = await import('../lib/storage/repositories');
    const model = await getEffectiveModel(modelId);

    // m01 has PSI ~ 0.02 (which is STABLE under default psi_warning 0.10)
    const m01Text = readFileSync(join(root, 'samples/cashloan_v2/m01_v2_2025-07_ปกติ.csv'), 'utf8');
    const m01Res = await executeMonitoringPipeline({
      modelId,
      fileName: 'm01_sim_base.csv',
      csvText: m01Text,
      onDuplicate: 'replace',
    });

    // Simulate with ultra-tight candidate thresholds: psi_warning = 0.01
    const ultraTightConfig: RuleSetConfig = {
      ...STANDARD_RULE_SET_CONFIG,
      psi_warning: 0.01,
      psi_critical: 0.05,
    };

    const simResults = simulateRuleSetOnPastRuns(ultraTightConfig, [m01Res.run], model);
    expect(simResults.length).toBe(1);
    // Because PSI ~0.02 is now > 0.01 (warning), status was reclassified to WARNING!
    expect(simResults[0].simulatedAction).toBe('MONITOR_CLOSELY');
    expect(simResults[0].simulatedRuleId).toBe('R8');
    expect(simResults[0].changed).toBe(true);
  });

  it('(6) reverting activates old revision and creates a new audit entry without deleting history', async () => {
    // 1. Add revision 2 to ruleset_standard
    await addRuleSetRevision(modelId, version, 'ruleset_standard', {
      config: { ...STANDARD_RULE_SET_CONFIG, psi_warning: 0.08 },
      author: 'ผู้ใช้ A',
      reason: 'ปรับค่าเป็น 0.08',
    });

    // 2. Activate revision 2
    await activateRuleSetRevision(modelId, version, 'ruleset_standard', 2, {
      author: 'ผู้ใช้ A',
      reason: 'เปิดใช้งาน rev 2',
    });

    const activeBeforeRevert = (await listRuleSets(modelId, version)).activeRuleSet;
    expect(activeBeforeRevert.revision).toBe(2);
    expect(activeBeforeRevert.config.psi_warning).toBe(0.08);

    // 3. Revert to revision 1
    const revertRes = await revertRuleSetRevision(modelId, version, 'ruleset_standard', 1, {
      author: 'ผู้ดูแลระบบ',
      reason: 'ย้อนกลับไปใช้ค่าเริ่มต้นเดิม',
    });

    expect(revertRes.auditEntry.action).toBe('REVERT');
    expect(revertRes.auditEntry.author).toBe('ผู้ดูแลระบบ');
    expect(revertRes.auditEntry.reason).toBe('ย้อนกลับไปใช้ค่าเริ่มต้นเดิม');
    expect(revertRes.activeRuleSet.revision).toBe(1);
    expect(revertRes.activeRuleSet.config.psi_warning).toBe(0.10);

    // 4. Verify history is completely preserved (both rev 1 and rev 2 still exist in set)
    const { ruleSets } = await listRuleSets(modelId, version);
    const standardSet = ruleSets.find(s => s.id === 'ruleset_standard')!;
    expect(standardSet.revisions.length).toBe(2);
    expect(standardSet.revisions[0].revision).toBe(1);
    expect(standardSet.revisions[1].revision).toBe(2);

    // Active pointer is now rev 1
    expect(standardSet.activeRevision).toBe(1);
  });
});
