/**
 * docusignParser.js
 * Utility functions for parsing DocuSign envelope data into
 * normalized internal models.
 */

// ─── Template Type Detection ───────────────────────────────────────────────

/**
 * Determines the template type based on the primary document name.
 * @param {object} envelope - Raw DocuSign envelope metadata object.
 * @param {object} documents - DocuSign documents response for this envelope.
 * @returns {'Presentacion de Casos'|'Board Referendum'}
 */
function getTemplateType(envelope, documents) {
  const docs = (documents && documents.envelopeDocuments) || [];
  const contentDoc = docs.find(d => d.type === 'content');
  const docName = (contentDoc && contentDoc.name) || '';
  const subject = envelope.emailSubject || '';
  
  // Normalize strings to remove accents and make lowercase
  const normalize = (str) => String(str || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  
  const lowerDoc = normalize(docName);
  const lowerSub = normalize(subject);

  if (
    lowerDoc.includes('presentacioncaso') || 
    lowerDoc.includes('presentacion de caso') ||
    lowerSub.includes('presentacion de caso') ||
    lowerSub.includes('presentacioncaso')
  ) {
    return 'Presentacion de Casos';
  }
  return 'Board Referendum';
}

/**
 * Matches an envelope to a stored template from Admin configuration.
 * @param {object} envelope
 * @param {object} documents
 * @param {Array<object>} storedTemplates
 * @returns {object|null}
 */
function matchTemplateConfig(envelope = {}, documents = {}, storedTemplates = []) {
  if (!Array.isArray(storedTemplates) || storedTemplates.length === 0) return null;

  const normalize = (str) =>
    String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

  // 1. Direct templateId match if present
  if (envelope.templateId) {
    const byId = storedTemplates.find(t => t.templateId === envelope.templateId);
    if (byId) return byId;
  }

  const docs = (documents && documents.envelopeDocuments) || [];
  const contentDoc = docs.find(d => d.type === 'content');
  const docName = normalize((contentDoc && contentDoc.name) || '');
  const subject = normalize(envelope.emailSubject || envelope.subject || '');
  const inferredType = normalize(getTemplateType(envelope, documents));

  // 2. Match by configured templateName or DocuSign template name
  for (const t of storedTemplates) {
    const cfgName = normalize(t.config && t.config.templateName);
    const rawName = normalize(t.name);
    for (const candidate of [cfgName, rawName].filter(Boolean)) {
      if (
        (docName && (docName.includes(candidate) || candidate.includes(docName.replace(/\.pdf$/i, '')))) ||
        (subject && subject.includes(candidate)) ||
        candidate === inferredType
      ) {
        return t;
      }
    }
  }

  return null;
}

// ─── Tab Extraction Helpers ────────────────────────────────────────────────

/**
 * Collects all tabs across all recipients (signers + inPersonSigners)
 * into a flat array of { tabLabel, value } objects.
 * @param {object} recipients - DocuSign recipients object.
 * @returns {Array<{tabLabel: string, value: string}>}
 */
function flattenAllRecipientTabs(recipients) {
  const flat = [];
  const groups = [
    ...(recipients.signers || []),
    ...(recipients.inPersonSigners || []),
    ...(recipients.agents || []),
    ...(recipients.editors || []),
  ];

  for (const person of groups) {
    const tabs = person.tabs || {};
    for (const tabList of Object.values(tabs)) {
      if (!Array.isArray(tabList)) continue;
      for (const tab of tabList) {
        if (tab.tabLabel) {
          flat.push({ tabLabel: tab.tabLabel, value: tab.value || '' });
        }
      }
    }
  }
  return flat;
}

/**
 * Finds the value of a text tab by an exact (case-insensitive) label name.
 * @param {Array<{tabLabel: string, value: string}>} flatTabs
 * @param {string} name
 * @returns {string|null}
 */
function findTabValue(flatTabs, name) {
  const lowerName = name.toLowerCase();
  const match = flatTabs.find(t => t.tabLabel.toLowerCase() === lowerName);
  return match ? match.value.trim() : null;
}

// ─── DocGen Form Fields Parser ───────────────────────────────────────────────

/**
 * Flattens docGenFormFields API response into a simple label→value map.
 * @param {object|null} docGenFormFields - Response from /docGenFormFields endpoint.
 * @returns {Object<string, string>} e.g. { 'Hora limite votar': '5', ... }
 */
function parseDocGenFields(docGenFormFields) {
  const map = {};
  if (!docGenFormFields || !docGenFormFields.docGenFormFields) return map;
  for (const doc of docGenFormFields.docGenFormFields) {
    for (const field of (doc.docGenFormFieldList || [])) {
      if (field.label && field.value !== undefined) {
        map[field.label.toLowerCase()] = field.value;
      }
    }
  }
  return map;
}

/**
 * Finds a value by label (case-insensitive) from a docGen field map.
 * @param {Object<string, string>} docGenMap
 * @param {string} label
 * @returns {string|null}
 */
function findDocGenValue(docGenMap, label) {
  const val = docGenMap[label.toLowerCase()];
  return (val !== undefined && val !== null && val !== '') ? String(val).trim() : null;
}

// ─── Expiration Date Parser ────────────────────────────────────────────────

/**
 * Builds a human-readable "hora final de voto" string from docGen fields.
 * Returns null when any field is missing.
 *
 * Example output: "08/14/2026 5:00 PM"
 *
 * @param {Object<string, string>} docGenMap - From parseDocGenFields().
 * @returns {string|null}
 */
function parseHoraFinalVoto(docGenMap) {
  const fecha    = findDocGenValue(docGenMap, 'Fecha Limite para votar');
  const hora     = findDocGenValue(docGenMap, 'Hora limite votar');
  const minutos  = findDocGenValue(docGenMap, 'Minutos Limite para votar');
  // Note: actual API label is 'Meridiem Limite para votar' (no 'el' suffix)
  const meridiem = findDocGenValue(docGenMap, 'Meridiem Limite para votar')
                || findDocGenValue(docGenMap, 'Meridiem Limite para votar el');

  if (fecha && hora && minutos && meridiem) {
    const min = String(minutos).padStart(2, '0');
    return `${fecha} ${hora}:${min} ${meridiem.toUpperCase()}`;
  }
  return null;
}

/**
 * Parses the expiration datetime for a Presentacion de Casos envelope.
 *
 * Priority:
 *   1. Template fields (Fecha / Hora / Minutos / Meridiem tabs) → horaFinalVoto
 *   2. DocuSign API envelope.expireDateTime field
 *   3. envelope.createdDateTime + envelope.expireAfter days
 *
 * @param {Array<{tabLabel: string, value: string}>} flatTabs
 * @param {object} envelope - Raw DocuSign envelope object.
 * @returns {string} ISO timestamp string for the expiration moment.
 */
function parseExpiresAt(docGenMap, envelope) {
  // 1. DocGen template fields
  const horaFinal = parseHoraFinalVoto(docGenMap);
  if (horaFinal) {
    try {
      const parsed = new Date(horaFinal);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString();
      }
    } catch (e) { /* fall through */ }
  }

  // 2. DocuSign API expireDateTime
  if (envelope.expireDateTime) {
    const d = new Date(envelope.expireDateTime);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // 3. createdDateTime + expireAfter days
  const created     = new Date(envelope.createdDateTime || Date.now());
  const expireDays  = parseInt(envelope.expireAfter || '30', 10);
  return new Date(created.getTime() + expireDays * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Asuntos a Aprobar Parser ──────────────────────────────────────────────

/**
 * Extracts the generalized content text (Asunto or Resumen) from docGen fields or text tabs.
 * Falls back to a cleaned-up version of the email subject.
 * @param {Object<string, string>} docGenMap - From parseDocGenFields().
 * @param {Array<{tabLabel: string, value: string}>} flatTabs - All flattened recipient tabs.
 * @param {object} envelope - Raw envelope object for fallback.
 * @param {string} templateType - Type of the envelope.
 * @param {object} templateConfig - The template configurations from DB.
 * @returns {string}
 */
function parseContentText(docGenMap, flatTabs, envelope, configuredContentField = null) {
  const candidateFields = [
    configuredContentField,
    'Asuntos a Aprobar',
    'Resumen',
    'Asunto',
  ].filter(Boolean);

  for (const fieldName of candidateFields) {
    const val = findDocGenValue(docGenMap, fieldName) || findTabValue(flatTabs, fieldName);
    if (val) return val;
  }

  // Fallback: clean the email subject
  const subject = envelope.emailSubject || '';
  return subject
    .replace(/^Complete with Docusign:\s*/i, '')
    .replace(/^Complete this envelope with Docusign\s*/i, '')
    .trim() || subject;
}

// ─── Vote Normalization ────────────────────────────────────────────────────

/**
 * Cleans a raw checkbox tabLabel and ignores auto-generated UUIDs.
 * We no longer restrict choices to a strict config, but we do filter out junk.
 * @param {string} rawLabel
 * @returns {string|null}
 */
function getStandardChoice(rawLabel) {
  if (!rawLabel) return null;
  const cleanLabel = String(rawLabel).split('|')[0].trim();
  if (!cleanLabel) return null;

  // If the label is an auto-generated DocuSign Checkbox/Radio UUID, ignore it
  if (/^(Checkbox|Radio)\s+[a-f0-9\-]+$/i.test(cleanLabel)) {
    return null;
  }

  return cleanLabel;
}

/**
 * Inspects a template's (or envelope's) recipients object for voting controls:
 * radioGroupTabs, checkboxTabs, and textTabs.
 *
 * @param {object} recipients - DocuSign recipients object (with include_tabs=true).
 * @returns {{
 *   hasRadioButtons: boolean,
 *   hasCheckboxes: boolean,
 *   isValid: boolean,
 *   voteControlType: 'radio'|'checkbox'|'both'|'none',
 *   radioGroups: Array<{ groupName: string, options: string[] }>,
 *   checkboxOptions: string[],
 *   voteOptions: string[],
 *   textFields: string[]
 * }}
 */
function inspectTemplateTabs(recipients = {}) {
  const groups = [
    ...(recipients.signers || []),
    ...(recipients.inPersonSigners || []),
    ...(recipients.agents || []),
    ...(recipients.editors || []),
  ];

  const radioGroupMap = new Map(); // groupName -> Set(options)
  const checkboxSet = new Set();
  const textFieldSet = new Set();

  for (const person of groups) {
    const tabs = person.tabs || {};

    // 1. Radio Button Groups (tabs.radioGroupTabs)
    for (const rg of (tabs.radioGroupTabs || [])) {
      const groupName = (rg.groupName || 'Radio Group').trim();
      const radios = rg.radios || [];
      for (const r of radios) {
        const opt = getStandardChoice(r.value || r.tabLabel);
        if (opt) {
          if (!radioGroupMap.has(groupName)) {
            radioGroupMap.set(groupName, new Set());
          }
          radioGroupMap.get(groupName).add(opt);
        }
      }
    }

    // 2. Checkboxes (tabs.checkboxTabs)
    for (const cb of (tabs.checkboxTabs || [])) {
      const opt = getStandardChoice(cb.tabLabel || cb.name);
      if (opt) checkboxSet.add(opt);
    }

    // 3. Text / Data tabs (useful for contentField selection in Admin)
    for (const [tabType, tabList] of Object.entries(tabs)) {
      if (tabType === 'checkboxTabs' || tabType === 'radioGroupTabs') continue;
      if (!Array.isArray(tabList)) continue;
      for (const t of tabList) {
        if (t.tabLabel && !/^(Text|Label|Note)\s+[a-f0-9\-]+$/i.test(t.tabLabel.trim())) {
          textFieldSet.add(t.tabLabel.trim());
        }
      }
    }
  }

  const radioGroups = Array.from(radioGroupMap.entries()).map(([groupName, set]) => ({
    groupName,
    options: Array.from(set),
  }));
  const checkboxOptions = Array.from(checkboxSet);

  const voteOptionsSet = new Set();
  for (const rg of radioGroups) {
    for (const opt of rg.options) voteOptionsSet.add(opt);
  }
  for (const opt of checkboxOptions) {
    voteOptionsSet.add(opt);
  }

  const hasRadioButtons = radioGroups.length > 0;
  const hasCheckboxes = checkboxOptions.length > 0;
  const isValid = hasRadioButtons || hasCheckboxes;
  const voteControlType =
    hasRadioButtons && hasCheckboxes
      ? 'both'
      : hasRadioButtons
        ? 'radio'
        : hasCheckboxes
          ? 'checkbox'
          : 'none';

  return {
    hasRadioButtons,
    hasCheckboxes,
    isValid,
    voteControlType,
    radioGroups,
    checkboxOptions,
    voteOptions: Array.from(voteOptionsSet),
    textFields: Array.from(textFieldSet),
  };
}

/**
 * Returns true if the recipients object contains at least one valid
 * voting control (radio button group or non-UUID checkbox tab).
 * @param {object} recipients - Raw DocuSign recipients object.
 * @returns {boolean}
 */
function hasCheckboxes(recipients) {
  return inspectTemplateTabs(recipients).isValid;
}

// ─── Main Envelope Builder ─────────────────────────────────────────────────

/**
 * Converts raw DocuSign API data into a normalized envelope object
 * suitable for storage.
 *
 * @param {object} envelope - Raw envelope from listEnvelopes
 * @param {object} recipients - From getEnvelopeRecipientsWithTabs
 * @param {object} documents - From the documents endpoint
 * @param {object|null} docGenFormFields - From the docGenFormFields endpoint
 * @param {object} templateConfig - The template configurations from DB.
 * @returns {object} Normalized envelope object
 */
function buildNormalizedEnvelope(envelope, recipients, documents, docGenFormFields, storedTemplates = []) {
  const matchedTemplate = matchTemplateConfig(envelope, documents, storedTemplates);
  const templateConfig = (matchedTemplate && matchedTemplate.config) || null;
  const trackingDisabled = Boolean(templateConfig && templateConfig.enabled === false);

  const templateType =
    (templateConfig && templateConfig.templateName) ||
    (matchedTemplate && matchedTemplate.name) ||
    getTemplateType(envelope, documents);

  const docGenMap = parseDocGenFields(docGenFormFields);

  // Build per-signer vote data
  const allSigners = [
    ...(recipients.signers || []),
    ...(recipients.inPersonSigners || []),
  ];

  const totals = {};
  const availableChoices = new Set(
    (templateConfig && Array.isArray(templateConfig.voteOptions) ? templateConfig.voteOptions : [])
  );
  const recipientsList = [];

  // No-vote category label (voters who are eligible but have not registered any choice).
  const NO_VOTE_LABEL = 'Sin voto';

  for (const signer of allSigners) {
    const checkboxTabs = (signer.tabs && signer.tabs.checkboxTabs) || [];
    const radioGroupTabs = (signer.tabs && signer.tabs.radioGroupTabs) || [];
    const selectedChoices = [];

    // Check if this signer has any valid checkbox tabs or radio group options (i.e. they are a voter)
    const validCheckboxes = checkboxTabs.filter(tab => getStandardChoice(tab.tabLabel));
    const validRadios = [];
    for (const rg of radioGroupTabs) {
      for (const r of (rg.radios || [])) {
        if (getStandardChoice(r.value || r.tabLabel)) {
          validRadios.push(r);
        }
      }
    }

    if (validCheckboxes.length === 0 && validRadios.length === 0) continue; // Not a voter (e.g. Director Ejecutivo)

    for (const tab of validCheckboxes) {
      const choice = getStandardChoice(tab.tabLabel);
      availableChoices.add(choice);
      if (tab.selected === 'true' || tab.selected === true) {
        selectedChoices.push(choice);
        totals[choice] = (totals[choice] || 0) + 1;
      }
    }

    for (const radio of validRadios) {
      const choice = getStandardChoice(radio.value || radio.tabLabel);
      availableChoices.add(choice);
      if (radio.selected === 'true' || radio.selected === true) {
        selectedChoices.push(choice);
        totals[choice] = (totals[choice] || 0) + 1;
      }
    }

    // Count eligible voters who have not selected any option as "Sin voto".
    if (selectedChoices.length === 0) {
      totals[NO_VOTE_LABEL] = (totals[NO_VOTE_LABEL] || 0) + 1;
    }

    recipientsList.push({
      name: signer.name || signer.signerName || '',
      email: signer.email || signer.hostEmail || '',
      roleName: signer.roleName || '',
      status: signer.status || 'sent',
      signedDateTime: signer.signedDateTime || null,
      choices: selectedChoices,
    });
  }

  // Make the no-vote category a first-class, selectable choice for reporting.
  if (recipientsList.length > 0) {
    availableChoices.add(NO_VOTE_LABEL);
  }

  // ─── Quorum metadata ──────────────────────────────────────────────────────
  // A simple majority = floor(totalVoters / 2) + 1.
  const totalVoters = recipientsList.length;
  const votedCount = recipientsList.filter(r => r.choices.length > 0).length;
  const noVoteCount = totals[NO_VOTE_LABEL] || 0;
  const quorumThreshold = totalVoters > 0 ? Math.floor(totalVoters / 2) + 1 : 0;
  const hasQuorum = totalVoters > 0 && votedCount >= quorumThreshold;

  // Expiration and template-specific metadata (sourced from DocGen fields)
  const horaFinalVoto = parseHoraFinalVoto(docGenMap);
  const expiresAt =
    horaFinalVoto || templateType === 'Presentacion de Casos'
      ? parseExpiresAt(docGenMap, envelope)
      : null;

  const flatTabs = flattenAllRecipientTabs(recipients);
  const contentText = parseContentText(
    docGenMap,
    flatTabs,
    envelope,
    templateConfig && templateConfig.contentField
  );

  // Consolidate all fields for frontend viewing
  const allFields = { ...docGenMap };
  for (const tab of flatTabs) {
    if (tab.tabLabel && tab.value !== undefined && tab.value !== '') {
      allFields[tab.tabLabel] = tab.value;
    }
  }

  return {
    envelopeId: envelope.envelopeId,
    templateId: (matchedTemplate && matchedTemplate.templateId) || envelope.templateId || null,
    trackingDisabled,
    subject: envelope.emailSubject || '',
    status: envelope.status || 'sent',
    templateType,
    createdDateTime: envelope.createdDateTime,
    lastModified: envelope.statusChangedDateTime,
    horaFinalVoto,
    expiresAt,
    closedAt: null,
    contentText,
    recipients: recipientsList,
    totals,
    availableChoices: Array.from(availableChoices),
    // Quorum / participation metadata
    totalVoters,
    votedCount,
    noVoteCount,
    quorumThreshold,
    hasQuorum,
    templateFields: allFields,
  };
}

module.exports = {
  getTemplateType,
  matchTemplateConfig,
  flattenAllRecipientTabs,
  findTabValue,
  parseDocGenFields,
  findDocGenValue,
  parseHoraFinalVoto,
  parseExpiresAt,
  parseContentText,
  getStandardChoice,
  inspectTemplateTabs,
  hasCheckboxes,
  buildNormalizedEnvelope,
};
