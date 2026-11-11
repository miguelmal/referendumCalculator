/**
 * services/db/models.js
 * Canonical relational row <-> domain entity mappers for:
 *   - templates
 *   - envelopes
 *   - connect_events
 *   - sync_meta
 *
 * Ensures both the Redis driver and the PostgreSQL driver read and write identical structures.
 */

// ─── `templates` table ───────────────────────────────────────────────────────

function toTemplateRow(entity = {}, existingRow = null) {
  const prev = existingRow || {};
  return {
    template_id: entity.templateId || prev.template_id,
    name: entity.name ?? prev.name ?? '(Sin nombre)',
    description: entity.description ?? prev.description ?? '',
    folder_name: entity.folderName ?? prev.folder_name ?? '',
    shared: Boolean(entity.shared ?? prev.shared ?? false),
    is_valid: Boolean(entity.isValid ?? prev.is_valid ?? false),
    has_radio_buttons: Boolean(entity.hasRadioButtons ?? prev.has_radio_buttons ?? false),
    has_checkboxes: Boolean(entity.hasCheckboxes ?? prev.has_checkboxes ?? false),
    vote_control_type: entity.voteControlType ?? prev.vote_control_type ?? 'none',
    radio_groups: Array.isArray(entity.radioGroups) ? entity.radioGroups : (prev.radio_groups || []),
    checkbox_options: Array.isArray(entity.checkboxOptions) ? entity.checkboxOptions : (prev.checkbox_options || []),
    vote_options: Array.isArray(entity.voteOptions) ? entity.voteOptions : (prev.vote_options || []),
    text_fields: Array.isArray(entity.textFields) ? entity.textFields : (prev.text_fields || []),
    // Preserve custom admin config when re-syncing template structure from DocuSign
    config: entity.config !== undefined ? entity.config : (prev.config || null),
    created_at: entity.created ?? prev.created_at ?? null,
    last_modified: entity.lastModified ?? prev.last_modified ?? null,
    last_synced_at: entity.lastSyncedAt || new Date().toISOString(),
  };
}

function fromTemplateRow(row) {
  if (!row) return null;
  // Support legacy camelCase records already in Redis alongside snake_case table rows
  return {
    templateId: row.template_id || row.templateId,
    name: row.name || '(Sin nombre)',
    description: row.description || '',
    folderName: row.folder_name ?? row.folderName ?? '',
    shared: Boolean(row.shared),
    isValid: Boolean(row.is_valid ?? row.isValid),
    hasRadioButtons: Boolean(row.has_radio_buttons ?? row.hasRadioButtons),
    hasCheckboxes: Boolean(row.has_checkboxes ?? row.hasCheckboxes),
    voteControlType: row.vote_control_type || row.voteControlType || 'none',
    radioGroups: row.radio_groups || row.radioGroups || [],
    checkboxOptions: row.checkbox_options || row.checkboxOptions || [],
    voteOptions: row.vote_options || row.voteOptions || [],
    textFields: row.text_fields || row.textFields || [],
    config: row.config || null,
    created: row.created_at || row.created || null,
    lastModified: row.last_modified || row.lastModified || null,
    lastSyncedAt: row.last_synced_at || row.lastSyncedAt || null,
  };
}

// ─── `envelopes` table ───────────────────────────────────────────────────────

function toEnvelopeRow(envelopeId, entity = {}, existingRow = null) {
  const prev = existingRow ? fromEnvelopeRow(existingRow) : {};
  const merged = { ...prev, ...entity, envelopeId };

  // Preserve non-vote metadata if omitted on subsequent updates
  if (!entity.contentText && prev.contentText) merged.contentText = prev.contentText;
  if (!entity.horaFinalVoto && prev.horaFinalVoto) merged.horaFinalVoto = prev.horaFinalVoto;
  if (!entity.expiresAt && prev.expiresAt) merged.expiresAt = prev.expiresAt;

  return {
    envelope_id: envelopeId,
    template_id: merged.templateId || null,
    template_type: merged.templateType || 'Board Referendum',
    subject: merged.subject || '',
    status: merged.status || 'sent',
    content_text: merged.contentText || '',
    hora_final_voto: merged.horaFinalVoto || null,
    expires_at: merged.expiresAt || null,
    closed_at: merged.closedAt || null,
    created_date_time: merged.createdDateTime || null,
    last_modified: merged.lastModified || null,
    is_active_presentacion: Boolean(
      merged.isActivePresentacion ??
      (existingRow && existingRow.is_active_presentacion) ??
      false
    ),
    tracking_disabled: Boolean(merged.trackingDisabled),
    total_voters: Number(merged.totalVoters || 0),
    voted_count: Number(merged.votedCount || 0),
    no_vote_count: Number(merged.noVoteCount || 0),
    quorum_threshold: Number(merged.quorumThreshold || 0),
    has_quorum: Boolean(merged.hasQuorum),
    totals: merged.totals || {},
    recipients: merged.recipients || [],
    available_choices: merged.availableChoices || [],
    template_fields: merged.templateFields || {},
    updated_at: new Date().toISOString(),
  };
}

function fromEnvelopeRow(row) {
  if (!row) return null;
  // Support both snake_case relational rows and legacy camelCase objects
  return {
    envelopeId: row.envelope_id || row.envelopeId,
    templateId: row.template_id ?? row.templateId ?? null,
    templateType: row.template_type || row.templateType || 'Board Referendum',
    subject: row.subject || '',
    status: row.status || 'sent',
    contentText: row.content_text ?? row.contentText ?? '',
    horaFinalVoto: row.hora_final_voto ?? row.horaFinalVoto ?? null,
    expiresAt: row.expires_at ?? row.expiresAt ?? null,
    closedAt: row.closed_at ?? row.closedAt ?? null,
    createdDateTime: row.created_date_time ?? row.createdDateTime ?? null,
    lastModified: row.last_modified ?? row.lastModified ?? null,
    isActivePresentacion: Boolean(row.is_active_presentacion ?? row.isActivePresentacion ?? false),
    trackingDisabled: Boolean(row.tracking_disabled ?? row.trackingDisabled ?? false),
    totalVoters: Number(row.total_voters ?? row.totalVoters ?? 0),
    votedCount: Number(row.voted_count ?? row.votedCount ?? 0),
    noVoteCount: Number(row.no_vote_count ?? row.noVoteCount ?? 0),
    quorumThreshold: Number(row.quorum_threshold ?? row.quorumThreshold ?? 0),
    hasQuorum: Boolean(row.has_quorum ?? row.hasQuorum ?? false),
    totals: row.totals || {},
    recipients: row.recipients || [],
    availableChoices: row.available_choices || row.availableChoices || [],
    templateFields: row.template_fields || row.templateFields || {},
  };
}

// ─── `connect_events` table ──────────────────────────────────────────────────

function toConnectEventRow(entity = {}) {
  return {
    id: entity.id,
    received_at: entity.receivedAt || new Date().toISOString(),
    envelope_id: entity.envelopeId || null,
    event: entity.event || null,
    status: entity.status || null,
    signature_verified: Boolean(entity.signatureVerified),
    content_type: entity.contentType || null,
    raw: entity.raw || '',
  };
}

function fromConnectEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    receivedAt: row.received_at || row.receivedAt,
    envelopeId: row.envelope_id ?? row.envelopeId ?? null,
    event: row.event || null,
    status: row.status || null,
    signatureVerified: Boolean(row.signature_verified ?? row.signatureVerified),
    contentType: row.content_type ?? row.contentType ?? null,
    raw: row.raw || '',
  };
}

module.exports = {
  toTemplateRow,
  fromTemplateRow,
  toEnvelopeRow,
  fromEnvelopeRow,
  toConnectEventRow,
  fromConnectEventRow,
};
