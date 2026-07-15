/**
 * Model identity and configuration metadata.
 *
 * This module replaces the `name` field in the legacy model-config.json and
 * adds the full set of fields required for a production-ready model registry
 * entry: version, owner, training date, baseline dataset, lifecycle dates,
 * and publication status.
 */

import type { ModelInfo, ConfigMeta } from './types';

// ---------------------------------------------------------------------------
// Model information
// ---------------------------------------------------------------------------

export const modelInfo: ModelInfo = {
  modelId: 'ascore_personal_loan',
  name: 'Ascore Application Scorecard — Personal Loan',
  version: '1.0.0',
  owner: 'Credit Risk Analytics Team',
  trainingDate: '2025-01-15',
  baselineDataset: 'personal_loan_mock_data.xlsx',
  createdDate: '2025-01-20',
  updatedDate: '2026-07-15',
  status: 'Published',
};

// ---------------------------------------------------------------------------
// Configuration metadata (audit trail for this config snapshot)
// ---------------------------------------------------------------------------

export const configMeta: ConfigMeta = {
  configVersion: '1.0.0',
  createdDate: '2025-01-20',
  updatedDate: '2026-07-15',
  status: 'Published',
  createdBy: 'Credit Risk Analytics Team',
  updatedBy: 'Credit Risk Analytics Team',
};
