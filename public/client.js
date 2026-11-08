/* ════════════════════════════════════════════════════════════════════════
   DocuSign Vote Counter – client.js
   ════════════════════════════════════════════════════════════════════════ */

let allEnvelopes   = [];
let activeTab      = '';   // Will be set dynamically
let pendingActions = new Set();      // envelopeIds whose buttons are loading

let tabConfig = {};

// ─── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  bindRefresh();
  bindSearch();
  bindAdmin();
  fetchData();

  // On serverless (Vercel), background timers don't stay alive when idle.
  // Check every 60s while the dashboard is open for expired Presentaciones.
  setInterval(() => {
    const now = new Date();
    const hasNewlyExpired = allEnvelopes.some(env =>
      env.templateType === 'Presentacion de Casos' &&
      (env.status === 'sent' || env.status === 'delivered') &&
      env.expiresAt &&
      now >= new Date(env.expiresAt)
    );
    if (hasNewlyExpired) {
      console.log('⏰ [Client] Detected expired Presentación de Casos — triggering check...');
      fetchData();
    }
  }, 60 * 1000);
});

// ─── Data Fetching ─────────────────────────────────────────────────────────

let initialAutoSyncAttempted = false;

async function fetchData() {
  showContainerLoading();
  try {
    console.log('📡 [Client] Fetching /api/votes...');
    const resp = await fetch('/api/votes', { cache: 'no-store' });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.error('❌ [Client] /api/votes failed:', {
        url: resp.url,
        status: resp.status,
        statusText: resp.statusText,
        body: errBody,
      });
      throw new Error(`GET /api/votes → HTTP ${resp.status} ${resp.statusText}${errBody ? ` (${errBody.slice(0, 120)})` : ''}`);
    }

    const { envelopes = [], overallTotals = {}, environment = 'DEV', diagnostics, syncStatus } = await resp.json();
    console.log('✅ [Client] /api/votes loaded:', { count: envelopes.length, environment, diagnostics, syncStatus });

    // If cache is empty on first load, trigger a one-time sync from DocuSign automatically
    if (envelopes.length === 0 && !initialAutoSyncAttempted) {
      initialAutoSyncAttempted = true;
      console.log('🔄 [Client] Cache is empty on initial load — triggering POST /api/refresh...');
      const syncResp = await fetch('/api/refresh', { method: 'POST' });
      if (!syncResp.ok) {
        const errData = await syncResp.json().catch(() => ({}));
        throw new Error(errData.error || `POST /api/refresh → HTTP ${syncResp.status}`);
      }
      return await fetchData();
    }

    allEnvelopes = envelopes;

    if (syncStatus && syncStatus.lastSyncError) {
      console.warn('⚠️ [Client] Last DocuSign sync reported error:', syncStatus.lastSyncError);
    }

    const titleEl = document.querySelector('.header-title');
    if (titleEl) {
      titleEl.textContent = `Dashboard de Votaciones - ${environment}`;
    }

    const defaultClasses = ['in-favor', 'against', 'abstained', 'default-class'];
    const defaultIcons = ['✅', '❌', '⚠️', '🔹'];
    tabConfig = {};
    
    // Extract unique templateTypes
    const templateTypes = Array.from(new Set(envelopes.map(e => e.templateType))).filter(Boolean);

    templateTypes.forEach(templateType => {
      const tabId = templateType.toLowerCase().replace(/\s+/g, '-');
      
      // Infer options from envelopes
      const dynamicOptions = new Set();
      envelopes.forEach(e => {
        if (e.templateType === templateType) {
          (e.availableChoices || []).forEach(opt => dynamicOptions.add(opt));
          Object.keys(e.totals || {}).forEach(opt => dynamicOptions.add(opt));
        }
      });
      const options = Array.from(dynamicOptions);
      
      tabConfig[tabId] = {
        templateType,
        tabLabel: templateType,
        options: options,
        classes: options.map((_, i) => defaultClasses[i % defaultClasses.length]),
        labels: options.map((opt, i) => `${defaultIcons[i % defaultIcons.length]} ${opt}`),
        metaPrefix: `📌 Asunto: `
      };
    });

    buildTabsUI(syncStatus);

    document.getElementById('account-name-badge').textContent =
      `${envelopes.length} acuerdos cargados`;
  } catch (err) {
    showContainerError(err.message);
    showToast(`❌ Error al cargar datos: ${err.message}`, 'error');
  }
}

// ─── Tab Logic ─────────────────────────────────────────────────────────────

function buildTabsUI(syncStatus) {
  const tabNav = document.getElementById('tab-nav');
  tabNav.innerHTML = '';
  
  const tabKeys = Object.keys(tabConfig);
  if (tabKeys.length === 0) {
    if (syncStatus && syncStatus.lastSyncError) {
      showContainerError(`No se pudo sincronizar con DocuSign: ${syncStatus.lastSyncError}`);
    } else {
      renderAgreements([]);
    }
    return;
  }
  
  if (!activeTab || !tabConfig[activeTab]) {
    activeTab = tabKeys[0];
  }
  
  tabKeys.forEach(tabId => {
    const config = tabConfig[tabId];
    
    const count = allEnvelopes.filter(env => {
      if (env.templateType !== config.templateType) return false;
      return true;
    }).length;

    const btn = document.createElement('button');
    btn.className = `tab-btn ${tabId === activeTab ? 'active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', tabId === activeTab ? 'true' : 'false');
    btn.dataset.tab = tabId;
    btn.textContent = `📂 ${config.tabLabel || config.templateType} (${count})`;
    
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      activeTab = tabId;
      renderActiveTab();
    });
    
    tabNav.appendChild(btn);
  });
  
  // Render the initial active tab contents immediately
  renderActiveTab();
}

function getFilteredEnvelopesForTab(tabId) {
  const searchVal = document.getElementById('search-filter').value.trim().toLowerCase();
  const sortVal = document.getElementById('sort-select').value;
  const showCompleted = document.getElementById('show-completed-toggle').checked;
  const config = tabConfig[tabId];

  let filtered = allEnvelopes.filter(env => {
    // Tab filter
    if (config) {
      if (env.templateType !== config.templateType) return false;
    }

    // Completed filter
    const isClosed = env.status === 'closed' || env.status === 'completed' || env.status === 'voided';
    if (!showCompleted && isClosed) return false;

    // Search filter
    if (searchVal) {
      const haystack = [
        env.subject,
        env.contentText,
        ...(env.recipients || []).map(r => r.name),
      ].filter(Boolean).join(' ').toLowerCase();

      if (!haystack.includes(searchVal)) return false;
    }
    return true;
  });

  // Sort
  if (sortVal === 'newest') {
    filtered.sort((a, b) => new Date(b.createdDateTime || 0) - new Date(a.createdDateTime || 0));
  } else if (sortVal === 'oldest') {
    filtered.sort((a, b) => new Date(a.createdDateTime || 0) - new Date(b.createdDateTime || 0));
  } else {
    // Default: open first, then by soonest deadline (expiresAt)
    const order = { sent: 1, delivered: 1, completed: 2, closed: 2, voided: 3 };
    const FAR_FUTURE = new Date('2099-01-01').getTime();
    filtered.sort((a, b) => {
      const stA = order[a.status] || 99;
      const stB = order[b.status] || 99;
      if (stA !== stB) return stA - stB;
      const dueA = a.expiresAt ? new Date(a.expiresAt).getTime() : FAR_FUTURE;
      const dueB = b.expiresAt ? new Date(b.expiresAt).getTime() : FAR_FUTURE;
      return dueA - dueB; // soonest deadline first
    });
  }

  return filtered;
}

function getFilteredEnvelopes() {
  return getFilteredEnvelopesForTab(activeTab);
}

function renderActiveTab() {
  const currentConfig = tabConfig[activeTab];
  if (!currentConfig) return;
  
  document.getElementById('section-title').textContent = `Acuerdos – ${currentConfig.tabLabel || currentConfig.templateType}`;

  // Update ALL tab counters dynamically based on filters
  Object.keys(tabConfig).forEach(tabId => {
     const count = getFilteredEnvelopesForTab(tabId).length;
     const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
     if (btn) {
       btn.textContent = `📂 ${tabConfig[tabId].tabLabel || tabConfig[tabId].templateType} (${count})`;
     }
  });

  const filtered = getFilteredEnvelopesForTab(activeTab);
  renderAgreements(filtered);
}

// ─── Search ────────────────────────────────────────────────────────────────

function bindSearch() {
  document.getElementById('search-filter').addEventListener('input', renderActiveTab);
  document.getElementById('sort-select').addEventListener('change', renderActiveTab);
  document.getElementById('show-completed-toggle').addEventListener('change', renderActiveTab);
}

// ─── Admin Modal & Templates ───────────────────────────────────────────────

function bindAdmin() {
  const btnAdmin = document.getElementById('btn-admin');
  const btnClose = document.getElementById('btn-close-admin');
  const modal    = document.getElementById('admin-modal');
  const form     = document.getElementById('template-config-form');

  if (!btnAdmin || !modal) return;

  btnAdmin.addEventListener('click', () => {
    modal.showModal();
    loadAdminTemplates();
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => modal.close());
  }

  // Close when clicking outside the modal content
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      showToast('ℹ️ Selección de plantilla actualizada.', 'success');
    });
  }
}

async function loadAdminTemplates() {
  const container = document.getElementById('existing-templates');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 0;color:var(--text-muted);">
      <span class="spinner" style="width:16px;height:16px;"></span>
      Cargando plantillas disponibles de DocuSign…
    </div>`;

  try {
    console.log('📡 [Client] Fetching /api/templates...');
    const resp = await fetch('/api/templates', { cache: 'no-store' });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status} ${resp.statusText}${errBody ? ` (${errBody.slice(0, 120)})` : ''}`);
    }

    const data = await resp.json();
    console.log('✅ [Client] /api/templates loaded:', data);
    renderAdminTemplates(data);
  } catch (err) {
    console.error('❌ [Client] /api/templates failed:', err);
    container.innerHTML = `<div class="error-state" style="padding:12px;border-radius:8px;">❌ Error al cargar plantillas: ${escapeHtml(err.message)}</div>`;
  }
}

function renderAdminTemplates({ templates = [], detectedCategories = [], docusignError = null }) {
  const container = document.getElementById('existing-templates');
  if (!container) return;

  let html = '';

  if (docusignError) {
    html += `
      <div class="error-state" style="padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:0.85rem;">
        ⚠️ Error consultando plantillas en DocuSign: ${escapeHtml(docusignError)}
      </div>`;
  }

  // 1. DocuSign Account Templates
  html += `<h4 style="font-size:0.85rem;text-transform:uppercase;color:var(--text-muted);margin:0 0 8px 0;letter-spacing:0.04em;">📄 Plantillas en DocuSign (${templates.length})</h4>`;
  if (templates.length === 0) {
    html += `<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:16px;">No se encontraron plantillas en la cuenta de DocuSign.</p>`;
  } else {
    html += `<ul class="recipients-list" style="margin-bottom:18px;">`;
    for (const t of templates) {
      const modDate = t.lastModified ? new Date(t.lastModified).toLocaleDateString('es-PR') : '';
      const folder  = t.folderName ? `📁 ${escapeHtml(t.folderName)}` : '';
      const desc    = t.description ? `<div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;">${escapeHtml(t.description)}</div>` : '';
      html += `
        <li class="recipient-row" style="cursor:pointer;" data-template-name="${escapeHtml(t.name)}" data-template-id="${escapeHtml(t.templateId)}">
          <div class="rec-info">
            <span class="rec-name">📄 ${escapeHtml(t.name)}</span>
            <span class="rec-role" style="font-family:monospace;font-size:0.75rem;">ID: ${escapeHtml(t.templateId)}</span>
            ${folder ? `<span class="rec-role">${folder}</span>` : ''}
            ${desc}
          </div>
          <span class="rec-role">${modDate ? `📅 ${modDate}` : ''}</span>
        </li>`;
    }
    html += `</ul>`;
  }

  // 2. Detected Categories from Envelopes
  html += `<h4 style="font-size:0.85rem;text-transform:uppercase;color:var(--text-muted);margin:12px 0 8px 0;letter-spacing:0.04em;">🗂️ Categorías Activas en Acuerdos (${detectedCategories.length})</h4>`;
  if (detectedCategories.length === 0) {
    html += `<p style="color:var(--text-muted);font-size:0.85rem;">Sin categorías detectadas aún.</p>`;
  } else {
    html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">`;
    for (const cat of detectedCategories) {
      const opts = (cat.voteOptions || []).join(', ');
      html += `
        <span class="template-badge" data-cat-name="${escapeHtml(cat.name)}" data-cat-opts="${escapeHtml(opts)}" title="Opciones: ${escapeHtml(opts || 'N/A')}">
          ${escapeHtml(cat.name)} (${cat.envelopeCount})
        </span>`;
    }
    html += `</div>`;
  }

  container.innerHTML = html;

  // Bind click on DocuSign template rows or category badges to inspect/populate form
  container.querySelectorAll('[data-template-name]').forEach(row => {
    row.addEventListener('click', () => {
      selectTemplateInAdminForm(row.dataset.templateName, '');
    });
  });

  container.querySelectorAll('[data-cat-name]').forEach(badge => {
    badge.addEventListener('click', () => {
      selectTemplateInAdminForm(badge.dataset.catName, badge.dataset.catOpts || '');
    });
  });
}

function selectTemplateInAdminForm(name, voteOptionsCsv) {
  const form = document.getElementById('template-config-form');
  if (!form) return;
  form.style.display = 'block';
  document.getElementById('templateName').value = name || '';
  document.getElementById('voteOptions').value = voteOptionsCsv || '';
  document.getElementById('contentField').value =
    name === 'Presentacion de Casos' ? 'Asunto' : 'Resumen';
}

// ─── Admin Refresh ─────────────────────────────────────────────────────────

function bindRefresh() {
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;border-width:2px;border-top-color:#fff;"></span> Actualizando…';
    
    // Dim the main container elegantly
    const container = document.getElementById('agreements-container');
    container.style.transition = 'opacity 0.4s ease';
    container.style.opacity = '0.5';

    try {
      console.log('📡 [Client] Triggering POST /api/refresh...');
      const resp = await fetch('/api/refresh', { method: 'POST' });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error('❌ [Client] /api/refresh failed:', {
          url: resp.url,
          status: resp.status,
          statusText: resp.statusText,
          body: errBody,
        });
        throw new Error(`POST /api/refresh → HTTP ${resp.status} ${resp.statusText}${errBody ? ` (${errBody.slice(0, 120)})` : ''}`);
      }
      showToast('✅ Datos actualizados. Recargando...', 'success');
      
      // Wait a moment so the user reads the toast, then reload elegantly
      setTimeout(() => {
        window.location.reload();
      }, 1200);
    } catch (err) {
      showToast(`❌ Error al actualizar: ${err.message}`, 'error');
      container.style.opacity = '1';
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">↻</span> Actualizar';
    }
  });
}

// ─── Render ────────────────────────────────────────────────────────────────

function renderAgreements(envelopes) {
  const container = document.getElementById('agreements-container');
  container.innerHTML = '';

  if (envelopes.length === 0) {
    container.innerHTML = `<div class="loading-state">Sin acuerdos para mostrar en esta categoría.</div>`;
    return;
  }

  for (const env of envelopes) {
    container.appendChild(buildCard(env));
  }
}

function buildCard(env) {
  const article = document.createElement('article');
  article.className = 'agreement-item';
  article.dataset.envelopeId = env.envelopeId;
  article.setAttribute('role', 'listitem');

  const totals   = env.totals || {};
  const config = Object.values(tabConfig).find(c => c.templateType === env.templateType) || Object.values(tabConfig)[0] || { options: [], classes: [], labels: [], metaPrefix: '📌 Asunto: ' };

  let envOptions = env.availableChoices && env.availableChoices.length > 0
    ? env.availableChoices
    : (Object.keys(totals).length > 0 ? Object.keys(totals) : config.options);

  let pillsHtml = '';
  envOptions.forEach((opt) => {
    const idx = config.options.indexOf(opt);
    const count = totals[opt] || 0;
    const pillClass = idx !== -1 ? config.classes[idx] : 'default-class';
    const pillLabel = idx !== -1 ? config.labels[idx] : `🔹 ${opt}`;
    pillsHtml += `<span class="vote-pill ${pillClass}">${pillLabel} <strong>${count}</strong></span>\n          `;
  });

  const badgeClass = {
    completed: 'badge-completed',
    sent:      'badge-sent',
    closed:    'badge-closed',
    waiting:   'badge-waiting',
  }[env.status] || 'badge-waiting';

  const badgeLabel = {
    completed: 'Completado',
    sent:      'En Progreso',
    closed:    'Cerrado',
    waiting:   'Esperando',
  }[env.status] || env.status;

  const isClosed = env.status === 'closed' || env.status === 'completed';

  // Presentacion de Casos expiry info
  let expiresHtml = '';
  if (env.templateType === 'Presentacion de Casos') {
    if (env.closedAt) {
      const closedStr = new Date(env.closedAt).toLocaleString('es-PR');
      expiresHtml = `<span class="hora-final" title="Cerrado el ${closedStr}">🔒 Cerrado: ${closedStr}</span>`;
    } else if (env.horaFinalVoto) {
      // Show the configured deadline + a live countdown if expiresAt is valid
      let countdownHtml = '';
      if (env.expiresAt) {
        const expiresAt = new Date(env.expiresAt);
        const now = new Date();
        const diffMs = expiresAt - now;
        if (diffMs > 0) {
          let label;
          if (diffMs >= 86_400_000) {
            // > 24h: show days + hours
            const days  = Math.floor(diffMs / 86_400_000);
            const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
            label = `${days}d ${hours}h`;
          } else {
            // < 24h: show hours + minutes
            const hours = Math.floor(diffMs / 3_600_000);
            const mins  = Math.floor((diffMs % 3_600_000) / 60_000);
            label = `${hours > 0 ? hours + 'h ' : ''}${mins}m`;
          }
          const chipClass = diffMs < 3_600_000 ? 'expires-chip urgent' : 'expires-chip';
          countdownHtml = ` <span class="${chipClass}">${label}</span>`;
        }
      }
      expiresHtml = `<span class="hora-final">⏰ ${escapeHtml(env.horaFinalVoto)}</span>${countdownHtml}`;
    } else {
      expiresHtml = `<span class="hora-final missing">⏰ Sin hora límite</span>`;
    }
  }

  const modDate = env.lastModified
    ? new Date(env.lastModified).toLocaleDateString('es-PR')
    : '';

  // Action buttons
  let actionsHtml = '';
  if (isClosed) {
    actionsHtml = `
      <button class="btn btn-report" id="btn-report-${env.envelopeId}"
        onclick="sendReport('${env.envelopeId}')" title="Enviar reporte por correo">
        📧 Reportar
      </button>`;
  } else if (env.templateType === 'Presentacion de Casos') {
    if (env.status !== 'voided') {
      actionsHtml += `
      <button class="btn btn-close" id="btn-close-${env.envelopeId}"
        onclick="closeNow('${env.envelopeId}')" title="Cerrar votación ahora">
        🔒 Cerrar Ahora
      </button>`;
    }
    actionsHtml += `
      <button class="btn btn-report" id="btn-report-${env.envelopeId}"
        onclick="sendReport('${env.envelopeId}')" title="Enviar reporte por correo">
        📧 Reportar
      </button>`;
  }
  
  // Explicit details button to make it obvious
  actionsHtml += `
    <button class="btn" onclick="toggleDetail('${env.envelopeId}')" title="Ver campos y detalles">
      👁️ Detalles
    </button>`;

  // Generalized content field text (Asunto or Resumen)
  const contentText = env.contentText || env.subject || '';

  let metaTextHtml = '';
  if (contentText && contentText !== env.subject) {
    metaTextHtml = `<span class="agreement-meta" title="${escapeHtml(contentText)}">${config.metaPrefix}${escapeHtml(contentText)}</span>`;
  }

  article.innerHTML = `
    <div class="agreement-summary" onclick="toggleDetail('${env.envelopeId}')">
      <div class="row-1">
        <div class="agreement-info">
          <span class="agreement-title">${escapeHtml(env.subject)}</span>
          ${metaTextHtml}
        </div>
        <div class="meta-info">
          ${expiresHtml}
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          ${modDate ? `<span class="modified-date">${modDate}</span>` : ''}
        </div>
      </div>

      <div class="row-2">
        <div class="vote-pills">
          ${pillsHtml.trim()}
        </div>
        <div class="card-actions" onclick="event.stopPropagation()">
          ${actionsHtml}
          <span class="toggle-arrow" id="arrow-${env.envelopeId}">▼</span>
        </div>
      </div>
    </div>

    <div class="agreement-detail" id="detail-${env.envelopeId}">
      <div class="detail-inner">
        <p class="detail-section-title" style="margin-top:0; font-size: 0.95rem;">Plantilla: <span style="font-weight:normal;color:var(--text-muted);"></span>${env.templateType}</p>
        


        <p class="detail-section-title" style="margin-top:1rem;">📋 Detalle de Votos por Miembro</p>
        <ul class="recipients-list">
          ${buildRecipientRows(env.recipients || [], config)}
        </ul>
      </div>
    </div>`;

  return article;
}

function buildRecipientRows(recipients, config) {
  if (!recipients.length) {
    return `<li style="color:var(--text-muted);font-size:0.85rem;padding:10px 0;">Sin destinatarios registrados.</li>`;
  }

  return recipients.map(r => {
    const vote = r.choices && r.choices[0];
    let voteClass = 'none';
    let voteLabel = 'Sin voto';

    if (vote) {
      const idx = config.options.indexOf(vote);
      if (idx !== -1) {
        const recClasses = ['a-favor', 'no-a-favor', 'abstenido'];
        voteClass = recClasses[idx];
        voteLabel = config.labels[idx];
      } else {
        voteLabel = vote;
      }
    }

    const signedDateHtml = r.signedDateTime 
      ? `<span class="rec-role">📅 ${new Date(r.signedDateTime).toLocaleString('es-PR')}</span>`
      : '';
    const emailHtml = r.email 
      ? `<span class="rec-role" style="text-transform:lowercase;">✉️ ${escapeHtml(r.email)}</span>` 
      : '';

    return `
      <li class="recipient-row">
        <div class="rec-info">
          <span class="rec-name">${escapeHtml(r.name || '(Sin nombre)')}</span>
          ${emailHtml}
          ${signedDateHtml}
        </div>
        <span class="rec-vote ${voteClass}">${voteLabel}</span>
      </li>`;
  }).join('');
}

function buildTemplateFields(fields) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return `<li style="color:var(--text-muted);font-size:0.85rem;padding:10px 0;">No se encontraron campos adicionales.</li>`;
  }
  
  return entries.map(([key, value]) => {
    return `
      <li class="recipient-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
        <span class="rec-role" style="font-size: 0.75rem; text-transform: uppercase;">${escapeHtml(key)}</span>
        <span class="rec-name" style="font-size: 0.9rem; word-break: break-word;">${escapeHtml(value)}</span>
      </li>`;
  }).join('');
}

// ─── Detail Toggle ─────────────────────────────────────────────────────────

function toggleDetail(envelopeId) {
  const detail = document.getElementById(`detail-${envelopeId}`);
  const arrow  = document.getElementById(`arrow-${envelopeId}`);
  if (!detail) return;

  const isOpen = detail.classList.toggle('open');
  if (arrow) arrow.textContent = isOpen ? '▲' : '▼';
}

// ─── Actions ───────────────────────────────────────────────────────────────

async function closeNow(envelopeId) {
  if (pendingActions.has(envelopeId)) return;
  if (!confirm('¿Cerrar esta votación ahora? Se enviará el reporte por correo.')) return;

  pendingActions.add(envelopeId);
  const btn = document.getElementById(`btn-close-${envelopeId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Cerrando…'; }

  try {
    const resp = await fetch(`/api/close/${envelopeId}`, { method: 'POST' });
    const body = await resp.json();
    if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);

    showToast('✅ Votación cerrada y reporte enviado.', 'success');
    await fetchData();
  } catch (err) {
    showToast(`❌ No se pudo cerrar: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🔒 Cerrar Ahora'; }
  } finally {
    pendingActions.delete(envelopeId);
  }
}

async function sendReport(envelopeId) {
  if (pendingActions.has(envelopeId)) return;

  pendingActions.add(envelopeId);
  const btn = document.getElementById(`btn-report-${envelopeId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando…'; }

  try {
    const resp = await fetch(`/api/report/${envelopeId}`, { method: 'POST' });
    const body = await resp.json();
    if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);

    showToast('📧 Reporte enviado con éxito.', 'success');
  } catch (err) {
    showToast(`❌ Error al enviar reporte: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📧 Reportar'; }
    pendingActions.delete(envelopeId);
  }
}

// ─── UI Helpers ────────────────────────────────────────────────────────────

function showContainerLoading() {
  document.getElementById('agreements-container').innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      Consultando DocuSign…
    </div>`;
}

function showContainerError(msg) {
  document.getElementById('agreements-container').innerHTML = `
    <div class="loading-state error-state">
      ❌ Error: ${escapeHtml(msg)}
    </div>`;
}

let toastTimer;
function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className   = 'toast show';
  if (type === 'error')   toast.classList.add('toast-error');
  if (type === 'success') toast.classList.add('toast-success');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 3500);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}



