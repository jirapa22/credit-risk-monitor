import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const CONFIG_PATH = path.join(process.cwd(), 'app', 'model-config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function writeConfig(config: any) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getActiveModel(config: any) {
  return config.models[config.activeModelId];
}

function bumpVersion(current: string): string {
  const parts = current.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  return parts.join('.');
}

// ─── GET /api/model-config ───────────────────────────────────────────────────
export async function GET() {
  try {
    const config = readConfig();
    const model = getActiveModel(config);
    return NextResponse.json({ config, model, activeModelId: config.activeModelId });
  } catch (error) {
    console.error('GET /api/model-config error:', error);
    return NextResponse.json({ error: 'Failed to read config' }, { status: 500 });
  }
}

// ─── POST /api/model-config ──────────────────────────────────────────────────
// Handles: feature CRUD, thresholds update, publish/draft
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = readConfig();
    const model = getActiveModel(config);
    const now = new Date().toISOString();
    let changed = false;

    // ── 1. Update featureRegistry ──
    if (body.featureRegistry && typeof body.featureRegistry === 'object') {
      model.featureRegistry = {};
      let order = 1;
      for (const [key, feat] of Object.entries(body.featureRegistry as Record<string, any>)) {
        if (!key.trim()) continue;
        model.featureRegistry[key] = {
          featureId: feat.featureId || `feat_${Date.now()}_${order}`,
          columnName: feat.columnName || key,
          displayName: feat.displayName || key,
          description: feat.description || '',
          source: feat.source || '',
          dataType: feat.dataType || 'numeric',
          required: Boolean(feat.required ?? true),
          monitoringEnabled: Boolean(feat.monitoringEnabled ?? true),
          displayOrder: feat.displayOrder || order,
          validation: {
            minValue: feat.validation?.minValue ?? null,
            maxValue: feat.validation?.maxValue ?? null,
            allowNull: Boolean(feat.validation?.allowNull ?? false),
            defaultValue: feat.validation?.defaultValue ?? null,
            missingStrategy: feat.validation?.missingStrategy || 'reject',
          },
          binning: {
            method: feat.binning?.method || 'manual',
            numBins: Number(feat.binning?.numBins) || 5,
            boundaries: Array.isArray(feat.binning?.boundaries)
              ? feat.binning.boundaries.map(Number).filter(isFinite)
              : [],
            binLabels: Array.isArray(feat.binning?.binLabels)
              ? feat.binning.binLabels
              : [],
          },
          baselineDistribution: {
            mean: Number(feat.baselineDistribution?.mean) || null,
            std: Number(feat.baselineDistribution?.std) || null,
            median: Number(feat.baselineDistribution?.median) || null,
            p25: Number(feat.baselineDistribution?.p25) || null,
            p75: Number(feat.baselineDistribution?.p75) || null,
            min: Number(feat.baselineDistribution?.min) || null,
            max: Number(feat.baselineDistribution?.max) || null,
            missingPct: Number(feat.baselineDistribution?.missingPct) || 0,
            uniqueCount: feat.baselineDistribution?.uniqueCount ?? null,
          },
          csiThreshold: Number(feat.csiThreshold) || 0.10,
        };

        // Sync thresholds.csi_features for backward compat (monitoring-enabled only)
        if (feat.monitoringEnabled !== false) {
          if (!model.thresholds.csi_features) model.thresholds.csi_features = {};
          const fr = model.featureRegistry[key];
          model.thresholds.csi_features[key] = {
            label: fr.displayName,
            source: fr.source,
            threshold: fr.csiThreshold,
            bins: fr.binning.boundaries,
            bin_labels: fr.binning.binLabels,
          };
        }
        order++;
      }
      // Remove old csi_features that no longer exist in featureRegistry
      for (const k of Object.keys(model.thresholds.csi_features || {})) {
        if (!model.featureRegistry[k]) {
          delete model.thresholds.csi_features[k];
        }
      }
      changed = true;
    }

    // ── 2. Update thresholds (PSI/AUC/Gini/KS) ──
    if (body.thresholds && typeof body.thresholds === 'object') {
      const t = model.thresholds;
      const b = body.thresholds;
      if (b.psi_warning !== undefined) t.psi_warning = parseFloat(b.psi_warning);
      if (b.psi_critical !== undefined) t.psi_critical = parseFloat(b.psi_critical);
      if (b.gini_min !== undefined) t.gini_min = parseFloat(b.gini_min);
      if (b.auc_min !== undefined) t.auc_min = parseFloat(b.auc_min);
      if (b.ks_min !== undefined) t.ks_min = parseFloat(b.ks_min);
      changed = true;
    }

    // ── 3. Publish / Save as Draft ──
    const action = body.action; // 'publish' | 'draft' | 'save'
    if (action === 'publish') {
      const newVersion = bumpVersion(model.configVersion || '1.0.0');
      model.configVersion = newVersion;
      model.configStatus = 'published';
      model.configUpdatedAt = now;
      if (!model.configHistory) model.configHistory = [];
      model.configHistory.push({
        version: newVersion,
        updatedAt: now,
        status: 'published',
        note: body.note || 'Published',
      });
      changed = true;
    } else if (action === 'draft') {
      model.configStatus = 'draft';
      model.configUpdatedAt = now;
      if (!model.configHistory) model.configHistory = [];
      model.configHistory.push({
        version: model.configVersion || '1.0.0',
        updatedAt: now,
        status: 'draft',
        note: body.note || 'Saved as draft',
      });
      changed = true;
    } else if (changed) {
      // Auto-update timestamp on any change
      model.configStatus = 'draft';
      model.configUpdatedAt = now;
    }

    if (changed) {
      writeConfig(config);
    }

    return NextResponse.json({ success: true, model, configVersion: model.configVersion, configStatus: model.configStatus });
  } catch (error) {
    console.error('POST /api/model-config error:', error);
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
}
