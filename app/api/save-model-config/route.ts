import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const configPath = path.join(process.cwd(), 'app', 'model-config.json');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const activeId = config.activeModelId;
    const model = config.models[activeId];

    // Update thresholds
    if (body.thresholds && typeof body.thresholds === 'object') {
      if (!model.thresholds) model.thresholds = {};
      const t = model.thresholds;
      const b = body.thresholds;
      if (b.psi_warning !== undefined) t.psi_warning = parseFloat(b.psi_warning);
      if (b.psi_critical !== undefined) t.psi_critical = parseFloat(b.psi_critical);
      if (b.gini_min !== undefined) t.gini_min = parseFloat(b.gini_min);
      if (b.auc_min !== undefined) t.auc_min = parseFloat(b.auc_min);
      if (b.ks_min !== undefined) t.ks_min = parseFloat(b.ks_min);

      // Per-feature CSI configs — fully dynamic (any feature name, label, source, bins)
      if (b.csi_features && typeof b.csi_features === 'object') {
        // Replace entire csi_features object to support add/remove features
        t.csi_features = {};
        for (const [feat, cfg] of Object.entries(b.csi_features as Record<string, any>)) {
          t.csi_features[feat] = {
            label: cfg.label || feat,
            source: cfg.source || '',
            threshold: parseFloat(cfg.threshold) || 0.10,
            bins: Array.isArray(cfg.bins) ? cfg.bins.map((v: any) => parseFloat(v)).filter(isFinite) : [],
            bin_labels: Array.isArray(cfg.bin_labels) ? cfg.bin_labels : [],
          };
        }
      }
    }

    // Update baseline performance reference
    if (body.baseline_performance && typeof body.baseline_performance === 'object') {
      if (!model.baseline) model.baseline = {};
      if (!model.baseline.performance) model.baseline.performance = {};
      const bp = body.baseline_performance;
      if (bp.auc !== undefined) model.baseline.performance.test = {
        ...model.baseline.performance.test,
        auc: parseFloat(bp.auc),
      };
      if (bp.gini !== undefined) {
        if (!model.baseline.performance.test) model.baseline.performance.test = {};
        model.baseline.performance.test.gini = parseFloat(bp.gini);
      }
      if (bp.ks !== undefined) {
        if (!model.baseline.performance.test) model.baseline.performance.test = {};
        model.baseline.performance.test.ks = parseFloat(bp.ks);
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return NextResponse.json({ success: true, model });
  } catch (error) {
    console.error('Error POST /api/save-model-config:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
