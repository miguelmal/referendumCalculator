/* ════════════════════════════════════════════════════════════════════════
   DocuSign Vote Counter – client.js
   ════════════════════════════════════════════════════════════════════════ */

let allEnvelopes   = [];
let activeTab      = '';   // Will be set dynamically
let pendingActions = new Set();      // envelopeIds whose buttons are loading

let tabConfig = {};

// ─── Boot ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  bindRefresh();
  bindSearch();
  bindAdmin();

  const isAuth = await checkAuthStatus();
  if (isAuth) {
    fetchData();
  }
});

// ─── SSO Authentication ────────────────────────────────────────────────────

async function checkAuthStatus() {
  const urlParams = new URLSearchParams(window.location.search);
  const authError = urlParams.get('auth_error');
  if (authError) {
    showToast(`❌ Error de autenticación SSO: ${authError}`, 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  try {
    const resp = await fetch('/auth/me', { cache: 'no-store' });
    const data = await resp.json();

    if (data.user && data.user.name) {
      const userBadge = document.getElementById('user-badge');
      const logoutBtn = document.getElementById('btn-logout');
      if (userBadge) {
        userBadge.textContent = `👤 ${data.user.name}`;
        userBadge.style.display = 'inline-block';
      }
      if (logoutBtn) {
        logoutBtn.style.display = 'inline-flex';
      }
    }

    if (data.ssoEnabled && !data.authenticated) {
      renderSsoLoginPrompt(data.loginUrl || '/auth/login', data.redirectUri, authError);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('⚠️ [Client] Could not check /auth/me:', err.message);
    return true;
  }
}

function renderSsoLoginPrompt(loginUrl, redirectUri, authError) {
  document.getElementById('account-name-badge').textContent = 'Sesión requerida';
  const container = document.getElementById('agreements-container');
  container.innerHTML = `
    <div class="loading-state" style="flex-direction:column;gap:16px;padding:48px 32px;">
      <div style="font-size:2rem;">🔐</div>
      <h3 style="margin:0;color:var(--navy);">Autenticación DocuSign (SSO)</h3>
      <p style="margin:0;max-width:460px;color:var(--text-muted);font-size:0.9rem;">
        Inicia sesión con tu cuenta corporativa de DocuSign para acceder al Dashboard de Votaciones y la configuración de plantillas.
      </p>
      ${authError ? `<div class="error-state" style="padding:10px 16px;border-radius:8px;font-size:0.85rem;">⚠️ ${escapeHtml(authError)}</div>` : ''}
      <a href="${escapeHtml(loginUrl)}" class="btn btn-refresh" style="text-decoration:none;padding:10px 24px;font-size:0.95rem;">
        🔑 Iniciar Sesión con DocuSign
      </a>
      ${redirectUri ? `
        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:8px;">
          Redirect URI (DocuSign Admin &rarr; Apps and Keys): <code>${escapeHtml(redirectUri)}</code>
        </div>
      ` : ''}
    </div>`;
}

// ─── Data Fetching ─────────────────────────────────────────────────────────

async function fetchData() {
  showContainerLoading();
  try {
    console.log('📡 [Client] Fetching /api/votes...');
    const resp = await fetch('/api/votes', { cache: 'no-store' });
    if (resp.status === 401) {
      const authData = await resp.json().catch(() => ({}));
      if (authData.ssoEnabled) {
        renderSsoLoginPrompt(authData.loginUrl || '/auth/login');
        return;
      }
    }
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

    const { envelopes = [], overallTotals = {}, environment = 'DEV', diagnostics } = await resp.json();
    console.log('✅ [Client] /api/votes loaded:', { count: envelopes.length, environment, diagnostics });

    allEnvelopes = envelopes;

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

let adminActiveTab = 'valid'; // 'valid' | 'invalid'
let lastAdminTemplatesPayload = null;

function bindAdmin() {
  const btnAdmin  = document.getElementById('btn-admin');
  const btnClose  = document.getElementById('btn-close-admin');
  const btnCancel = document.getElementById('btn-cancel-template-config');
  const modal     = document.getElementById('admin-modal');
  const form      = document.getElementById('template-config-form');

  if (!btnAdmin || !modal) return;

  btnAdmin.addEventListener('click', () => {
    modal.showModal();
    loadAdminTemplates();
  });

  if (btnClose) {
    btnClose.addEventListener('click', () => modal.close());
  }

  if (btnCancel && form) {
    btnCancel.addEventListener('click', () => {
      form.style.display = 'none';
    });
  }

  // Close when clicking outside the modal content
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const templateId = document.getElementById('templateId').value;
      const enabled = document.getElementById('trackTemplate').value === 'true';
      const templateName = document.getElementById('templateName').value.trim();
      const voteOptions = document.getElementById('voteOptions').value.trim();
      const contentField = document.getElementById('contentField').value.trim();
      const saveBtn = document.getElementById('btn-save-template-config');

      if (!templateId) {
        showToast('❌ Selecciona una plantilla primero.', 'error');
        return;
      }

      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '⏳ Guardando…';
      }

      try {
        const resp = await fetch(`/api/templates/${encodeURIComponent(templateId)}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateName, voteOptions, contentField, enabled }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        showToast(`✅ Configuración guardada (${enabled ? 'Rastrear: Sí' : 'Rastrear: No'}).`, 'success');
        form.style.display = 'none';
        renderAdminTemplates(data);
      } catch (err) {
        showToast(`❌ Error al guardar: ${err.message}`, 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Guardar Configuración';
        }
      }
    });
  }
}

async function loadAdminTemplates() {
  const container = document.getElementById('existing-templates');
  if (!container) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 0;color:var(--text-muted);">
      <span class="spinner" style="width:16px;height:16px;"></span>
      Cargando plantillas…
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

async function syncAdminTemplates(full = false) {
  const btn = document.getElementById(full ? 'btn-sync-templates-full' : 'btn-sync-templates-inc');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Sincronizando…';
  }

  try {
    const resp = await fetch('/api/templates/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    showToast(`✅ Sincronizadas ${data.syncedCount || 0} plantillas desde DocuSign.`, 'success');
    renderAdminTemplates(data);
  } catch (err) {
    showToast(`❌ Error sincronizando plantillas: ${err.message}`, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = full ? '🔁 Re-sincronizar Todas' : '🔄 Buscar Nuevas';
    }
  }
}

async function refreshSingleTemplateUI(templateId, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '⏳…';
  }
  try {
    const resp = await fetch(`/api/templates/${encodeURIComponent(templateId)}/refresh`, {
      method: 'POST',
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    const t = data.template || {};
    const statusLabel = t.isValid
      ? `✅ Válida (${t.hasRadioButtons ? '🔘 Radio' : ''}${t.hasRadioButtons && t.hasCheckboxes ? ' + ' : ''}${t.hasCheckboxes ? '☑️ Checkbox' : ''})`
      : '🚫 Sin opciones de voto';
    showToast(`🔄 "${t.name}" actualizada → ${statusLabel}`, 'success');
    renderAdminTemplates(data);
  } catch (err) {
    showToast(`❌ Error actualizando plantilla: ${err.message}`, 'error');
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = '🔄 Actualizar';
    }
  }
}

function buildTemplateControlBadges(t) {
  const badges = [];
  if (t.hasRadioButtons) {
    const groupSummary = (t.radioGroups || [])
      .map(rg => `${rg.groupName}: ${(rg.options || []).join(', ')}`)
      .join(' | ');
    badges.push(
      `<span class="badge badge-completed" title="${escapeHtml(groupSummary)}">🔘 Radio (${(t.radioGroups || []).length})</span>`
    );
  }
  if (t.hasCheckboxes) {
    badges.push(
      `<span class="badge badge-sent" title="${escapeHtml((t.checkboxOptions || []).join(', '))}">☑️ Checkboxes (${(t.checkboxOptions || []).length})</span>`
    );
  }
  if (t.config && t.config.updatedAt) {
    const isTracked = t.config.enabled !== false;
    badges.push(
      isTracked
        ? `<span class="badge" style="background:#dcfce7;color:#166534;border:1px solid #86efac;">🟢 Rastrear: Sí</span>`
        : `<span class="badge" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;">⚪ Rastrear: No</span>`
    );
  }
  return badges.join(' ');
}

function buildTemplateRowHtml(t, isValidSection) {
  const createdStr = t.created ? new Date(t.created).toLocaleDateString('es-PR') : 'n/a';
  const syncedStr  = t.lastSyncedAt ? new Date(t.lastSyncedAt).toLocaleTimeString('es-PR') : '';
  const effectiveOpts = (t.config && t.config.voteOptions && t.config.voteOptions.length)
    ? t.config.voteOptions
    : (t.voteOptions || []);
  const effectiveContentField = (t.config && t.config.contentField)
    ? t.config.contentField
    : ((t.textFields && t.textFields[0]) || 'Asuntos a Aprobar');
  const effectiveEnabled = (t.config && t.config.enabled !== undefined)
    ? String(t.config.enabled)
    : 'true';

  const radioDetailHtml = (t.radioGroups || []).map(rg =>
    `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;">
      🔘 <strong>${escapeHtml(rg.groupName)}</strong>: ${escapeHtml((rg.options || []).join(', '))}
    </div>`
  ).join('');

  const checkboxDetailHtml = (t.checkboxOptions && t.checkboxOptions.length > 0)
    ? `<div style="font-size:0.78rem;color:var(--text-muted);margin-top:2px;">
        ☑️ <strong>Checkboxes</strong>: ${escapeHtml(t.checkboxOptions.join(', '))}
      </div>`
    : '';

  return `
    <li class="recipient-row" style="align-items:flex-start;gap:12px;padding:10px 12px;">
      <div class="rec-info" style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="rec-name" style="font-weight:600;">📄 ${escapeHtml(t.name)}</span>
          ${buildTemplateControlBadges(t)}
        </div>
        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">
          <span style="font-family:monospace;">ID: ${escapeHtml(t.templateId)}</span>
          &bull; Creada: ${createdStr}
          ${syncedStr ? `&bull; Revisada: ${syncedStr}` : ''}
        </div>
        ${radioDetailHtml}
        ${checkboxDetailHtml}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;align-items:center;">
        ${isValidSection ? `
          <button type="button" class="btn" style="padding:5px 10px;font-size:0.78rem;"
            data-action="config"
            data-template-id="${escapeHtml(t.templateId)}"
            data-template-name="${escapeHtml((t.config && t.config.templateName) || t.name)}"
            data-vote-options="${escapeHtml(effectiveOpts.join(', '))}"
            data-content-field="${escapeHtml(effectiveContentField)}"
            data-enabled="${escapeHtml(effectiveEnabled)}"
            title="Configurar seguimiento, opciones y campo de contenido">
            ⚙️ Configurar
          </button>
        ` : ''}
        <button type="button" class="btn" style="padding:5px 10px;font-size:0.78rem;"
          data-action="refresh"
          data-template-id="${escapeHtml(t.templateId)}"
          title="Volver a consultar esta plantilla en DocuSign">
          🔄 Actualizar
        </button>
      </div>
    </li>`;
}

function renderAdminTemplates(payload) {
  if (payload) lastAdminTemplatesPayload = payload;
  const { validTemplates = [], invalidTemplates = [], syncMeta = {}, docusignError = null } =
    lastAdminTemplatesPayload || {};

  const container = document.getElementById('existing-templates');
  if (!container) return;

  const lastSyncStr = syncMeta.templates_last_synced_at
    ? new Date(syncMeta.templates_last_synced_at).toLocaleString('es-PR')
    : 'Nunca';
  const watermarkStr = syncMeta.templates_last_created_at
    ? new Date(syncMeta.templates_last_created_at).toLocaleDateString('es-PR')
    : 'Inicio';

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;background:var(--surface-2);padding:10px 14px;border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">
      <div style="font-size:0.8rem;color:var(--text-muted);">
        <div>🕒 Última sincronización: <strong>${escapeHtml(lastSyncStr)}</strong></div>
        <div>📅 Cursor fecha creación: <strong>${escapeHtml(watermarkStr)}</strong></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button type="button" class="btn btn-refresh" id="btn-sync-templates-inc" style="padding:6px 12px;font-size:0.8rem;" title="Busca en DocuSign solo plantillas creadas después de ${escapeHtml(watermarkStr)}">
          🔄 Buscar Nuevas
        </button>
        <button type="button" class="btn" id="btn-sync-templates-full" style="padding:6px 12px;font-size:0.8rem;" title="Vuelve a inspeccionar todas las plantillas en DocuSign">
          🔁 Re-sincronizar Todas
        </button>
      </div>
    </div>`;

  if (docusignError) {
    html += `
      <div class="error-state" style="padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:0.85rem;">
        ⚠️ Error consultando plantillas en DocuSign: ${escapeHtml(docusignError)}
      </div>`;
  }

  // Tabs bar inside Admin modal
  html += `
    <div class="tab-nav" style="padding:0;margin-bottom:14px;border-bottom:1px solid var(--border);background:transparent;">
      <button type="button" class="tab-btn ${adminActiveTab === 'valid' ? 'active' : ''}" data-admin-tab="valid">
        ✅ Válidas para Votación (${validTemplates.length})
      </button>
      <button type="button" class="tab-btn ${adminActiveTab === 'invalid' ? 'active' : ''}" data-admin-tab="invalid">
        🚫 Sin Opciones de Voto (${invalidTemplates.length})
      </button>
    </div>`;

  if (adminActiveTab === 'valid') {
    if (validTemplates.length === 0) {
      html += `<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:16px;">No hay plantillas con Radio Buttons ni Checkboxes almacenadas.</p>`;
    } else {
      html += `<ul class="recipients-list" style="margin-bottom:12px;">`;
      for (const t of validTemplates) {
        html += buildTemplateRowHtml(t, true);
      }
      html += `</ul>`;
    }
  } else {
    if (invalidTemplates.length === 0) {
      html += `<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:16px;">Ninguna plantilla sin opciones de voto.</p>`;
    } else {
      html += `<ul class="recipients-list" style="margin-bottom:12px;">`;
      for (const t of invalidTemplates) {
        html += buildTemplateRowHtml(t, false);
      }
      html += `</ul>`;
    }
  }

  container.innerHTML = html;

  // Bind Admin tabs
  container.querySelectorAll('button[data-admin-tab]').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      adminActiveTab = tabBtn.dataset.adminTab;
      renderAdminTemplates();
    });
  });

  // Bind incremental & full sync buttons
  const btnInc  = document.getElementById('btn-sync-templates-inc');
  const btnFull = document.getElementById('btn-sync-templates-full');
  if (btnInc)  btnInc.addEventListener('click', () => syncAdminTemplates(false));
  if (btnFull) btnFull.addEventListener('click', () => syncAdminTemplates(true));

  // Bind per-template Config and Refresh buttons
  container.querySelectorAll('button[data-action="config"]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectTemplateInAdminForm(
        btn.dataset.templateId,
        btn.dataset.templateName,
        btn.dataset.voteOptions,
        btn.dataset.contentField,
        btn.dataset.enabled
      );
    });
  });

  container.querySelectorAll('button[data-action="refresh"]').forEach(btn => {
    btn.addEventListener('click', () => {
      refreshSingleTemplateUI(btn.dataset.templateId, btn);
    });
  });
}

function selectTemplateInAdminForm(templateId, name, voteOptionsCsv, contentField, enabled = 'true') {
  const form = document.getElementById('template-config-form');
  if (!form) return;
  form.style.display = 'block';
  document.getElementById('templateId').value = templateId || '';
  document.getElementById('trackTemplate').value = String(enabled) === 'false' ? 'false' : 'true';
  document.getElementById('templateName').value = name || '';
  document.getElementById('voteOptions').value = voteOptionsCsv || '';
  document.getElementById('contentField').value = contentField || 'Asuntos a Aprobar';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Admin Refresh ─────────────────────────────────────────────────────────

function bindRefresh() {
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px;border-width:2px;border-top-color:#fff;"></span> Actualizando…';

    try {
      await fetchData();
      showToast('✅ Vista actualizada.', 'success');
    } catch (err) {
      showToast(`❌ Error al actualizar: ${err.message}`, 'error');
    } finally {
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



