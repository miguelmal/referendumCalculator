/**
 * emailService.js
 * Sends HTML vote-result emails via SMTP (nodemailer).
 * Supports Gmail App Passwords and Office 365 SMTP.
 *
 * Configuration (in .env):
 *   SMTP_HOST        → smtp.gmail.com | smtp.office365.com
 *   SMTP_PORT        → 587
 *   SMTP_SECURE      → false  (STARTTLS) | true (TLS/465)
 *   SMTP_USER        → your-email@gmail.com
 *   SMTP_PASS        → app-password or account-password
 *   SMTP_FROM_NAME   → "DocuSign Vote Counter"
 *   SMTP_FROM_EMAIL  → your-email@gmail.com
 */

const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this._transporter = null;
  }

  _getTransporter() {
    if (this._transporter) return this._transporter;

    this._transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    return this._transporter;
  }

  /**
   * Sends the vote result report to all recipients of an envelope.
   * @param {object} envelope - Normalized envelope from the database.
   * @param {string} triggerReason - Why the report was triggered:
   *   'completed' | 'expired' | 'manual'
   */
  async sendVoteReport(envelope, triggerReason = 'manual') {
    const { recipients, totals, subject, contentText, envelopeId, closedAt, templateType, availableChoices } = envelope;

    const contentLabel = templateType === 'Presentacion de Casos' ? 'Asunto' : 'Resumen';

    // Human-readable trigger banner
    const triggerBanners = {
      completed: {
        icon: '✅',
        text: 'Todos los miembros completaron su voto',
        color: '#065f46',
        bg: '#ecfdf5',
      },
      expired: {
        icon: '⏰',
        text: 'El tiempo límite para votar ha expirado',
        color: '#92400e',
        bg: '#fffbeb',
      },
      manual: {
        icon: '🔒',
        text: 'Cerrado manualmente por administrador',
        color: '#1e40af',
        bg: '#eff6ff',
      },
    };
    const banner = triggerBanners[triggerReason] || triggerBanners.manual;

    // Collect all unique recipient emails
    const toEmails = [...new Set(
      recipients
        .map(r => r.email)
        .filter(Boolean)
    )];

    if (toEmails.length === 0) {
      console.warn(`⚠️  No recipient emails found for envelope ${envelopeId}. Skipping email.`);
      return;
    }

    // Recipients who did NOT register a vote
    const noVotes = recipients.filter(r => r.choices.length === 0).map(r => r.name);

    // Build dynamic vote tally from actual choices
    const NO_VOTE_LABEL = 'Sin voto';
    const voteColors = ['#065f46', '#991b1b', '#92400e', '#1e40af', '#6b21a8', '#64748b'];
    const voteIcons  = ['✅', '❌', '⚠️', '🔹', '🔸', '•'];
    const choices = availableChoices || Object.keys(totals);
    // Percentages are based on actual cast votes, excluding the "Sin voto" bucket.
    const totalVotes = Object.entries(totals)
      .filter(([k]) => k !== NO_VOTE_LABEL)
      .reduce((a, [, v]) => a + v, 0);

    const tallyRowsHtml = choices.map((choice, i) => {
      const count = totals[choice] || 0;
      const isNoVote = choice === NO_VOTE_LABEL;
      const color = isNoVote ? '#64748b' : voteColors[i % voteColors.length];
      const icon  = isNoVote ? '🚫' : voteIcons[i % voteIcons.length];
      const pct   = (!isNoVote && totalVotes) ? Math.round(count / totalVotes * 100) : 0;
      const pctLabel = isNoVote ? '—' : `${pct}%`;
      const bgRow = i % 2 === 1 ? 'background:#fafafa;' : '';
      return `
                <tr style="${bgRow}">
                  <td style="padding:12px 14px;border:1px solid #e2e8f0;font-weight:700;color:${color};">
                    ${icon} ${escapeHtml(choice)}
                  </td>
                  <td style="text-align:center;padding:12px 14px;border:1px solid #e2e8f0;font-size:20px;font-weight:800;color:${color};">${count}</td>
                  <td style="text-align:center;padding:12px 14px;border:1px solid #e2e8f0;color:${color};">${pctLabel}</td>
                </tr>`;
    }).join('');

    const closedAtStr = closedAt
      ? new Date(closedAt).toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })
      : new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' });

    const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resultados de Votación</title>
</head>
<body style="margin:0;padding:0;background-color:#f0f4f8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8;padding:32px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">

          <!-- Header -->
          <tr>
            <td style="background:#ffffff;padding:32px 40px;text-align:center;border-bottom:3px solid #091c3f;">
              <img src="cid:prcda-logo" alt="PRCDA Logo" style="max-height:60px;margin-bottom:16px;">
              <h1 style="margin:0;color:#091c3f;font-size:22px;font-weight:700;letter-spacing:0.5px;">Resultados de la Votación</h1>
              <p style="margin:8px 0 0 0;color:#64748b;font-size:13px;">Reporte Oficial de Acuerdo de la Autoridad del Distrito de Convenciones</p>
            </td>
          </tr>

          <!-- Trigger Reason Banner -->
          <tr>
            <td style="padding:0 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;background:${banner.bg};border-radius:8px;border:1px solid ${banner.color}30;">
                <tr>
                  <td style="padding:14px 20px;font-size:14px;color:${banner.color};font-weight:600;">
                    ${banner.icon} ${banner.text}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:24px 40px 32px;">

              <!-- Agreement Details -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;background:#f8fafc;border-radius:8px;padding:20px;border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Asunto de Correo</p>
                    <p style="margin:0 0 16px 0;font-size:15px;color:#1e293b;font-weight:600;">${escapeHtml(subject)}</p>

                    <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">${contentLabel}</p>
                    <p style="margin:0 0 16px 0;font-size:15px;color:#1e293b;">${escapeHtml(contentText || subject)}</p>

                    <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;">Fecha de Cierre</p>
                    <p style="margin:0;font-size:14px;color:#64748b;">${closedAtStr}</p>
                  </td>
                </tr>
              </table>

              <!-- Vote Results -->
              <h2 style="margin:0 0 16px 0;font-size:16px;font-weight:700;color:#091c3f;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Tally de Votos</h2>

              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:28px;">
                <tr style="background:#f8fafc;">
                  <th style="text-align:left;padding:10px 14px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:600;">Opción</th>
                  <th style="text-align:center;padding:10px 14px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:600;">Votos</th>
                  <th style="text-align:center;padding:10px 14px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;font-weight:600;">%</th>
                </tr>
                ${tallyRowsHtml}
              </table>

              ${noVotes.length > 0 ? `
              <!-- Pending voters (quorum) -->
              <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:700;color:#091c3f;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Miembros sin Voto Registrado (Quórum)</h2>
              <ul style="margin:0 0 28px 0;padding-left:20px;color:#64748b;font-size:14px;">
                ${noVotes.map(n => `<li style="margin-bottom:4px;">${escapeHtml(n)}</li>`).join('')}
              </ul>
              ` : ''}

              <!-- All recipient votes -->
              <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:700;color:#091c3f;border-bottom:2px solid #e2e8f0;padding-bottom:8px;">Detalle por Miembro</h2>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:8px;">
                <tr style="background:#f8fafc;">
                  <th style="text-align:left;padding:8px 12px;border:1px solid #e2e8f0;font-size:12px;color:#64748b;">Nombre</th>
                  <th style="text-align:center;padding:8px 12px;border:1px solid #e2e8f0;font-size:12px;color:#64748b;">Voto</th>
                </tr>
                ${recipients.map(r => {
                  const vote = r.choices[0] || 'Sin voto';
                  const voteColor = vote === 'Sin voto' ? '#64748b' : '#1e293b';
                  return `
                  <tr>
                    <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#1e293b;">${escapeHtml(r.name)}</td>
                    <td style="text-align:center;padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:${voteColor};">${escapeHtml(vote)}</td>
                  </tr>`;
                }).join('')}
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Enviado automáticamente por el Sistema de Votación Digital &bull; DocuSign Vote Counter<br/>
                Autoridad del Distrito de Convenciones de Puerto Rico (PRCDA)
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const transporter = this._getTransporter();
    const fromName  = process.env.SMTP_FROM_NAME  || 'DocuSign Vote Counter';
    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: toEmails.join(', '),
      subject: `Resultados de Votación: ${subject}`,
      html,
      attachments: [{
        filename: 'logo.png',
        path: require('path').join(__dirname, '../public/logo.png'),
        cid: 'prcda-logo' // same cid value as in the html img src
      }]
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log(`📧 Email report sent for envelope ${envelopeId} → ${info.messageId}`);
      console.log(`   To: ${toEmails.join(', ')}`);
    } catch (err) {
      console.error(`❌ Failed to send email for envelope ${envelopeId}:`, err.message);
      throw err;
    }
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = new EmailService();
