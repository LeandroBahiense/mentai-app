/**
 * Pallyum — Helpers de email transacional (via Resend)
 *
 * Resend API: https://resend.com/docs/api-reference/emails/send-email
 * Domínio pallyum.com verificado em sa-east-1 (São Paulo).
 *
 * Convenção: emails enviados de noreply@pallyum.com. O domínio não recebe
 * email (Enable Receiving está OFF no Resend), então respostas vão pro limbo.
 */

const RESEND_API_KEY            = process.env.RESEND_API_KEY;
const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FROM_ADDRESS = 'Pallyum <noreply@pallyum.com>';

// Mapa de slug do plano para nome amigável (espelho do PLAN_LABELS do frontend)
// Catálogo ativo desde 01/06/2026: essencial, pro, ultra, design_partner.
// Entradas legadas mantidas (comentadas) para não quebrar e-mails históricos.
const PLAN_DISPLAY_NAMES = {
  // ── Planos ativos ──────────────────────────────────────────
  'essencial':      'Essencial',
  'pro':            'Pro',
  'ultra':          'Ultra',
  'design_partner': 'Design Partner',

  // === Planos legados desativados em 01/06/2026 — manter pra e-mails históricos ===
  // 'companion-teste':           'Companion Teste',
  // 'companion-essencial':       'Companion Essencial',
  // 'companion-pro':             'Companion Pro',
  // 'companion-ultra':           'Companion Ultra',
  // 'segundo-cerebro-essencial': 'Segundo Cérebro Essencial',
  // 'segundo-cerebro-pro':       'Segundo Cérebro Pro',
  // 'segundo-cerebro-ultra':     'Segundo Cérebro Ultra',
  // 'coletivo-team':             'Coletivo Team',
  // 'coletivo-business':         'Coletivo Business',
  // 'duo-essencial':             'Duo Essencial',
  // 'duo-pro':                   'Duo Pro',
  // 'duo-ultra':                 'Duo Ultra',
  // ============================================================================
};

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

// ── Resolvers de email do usuário ────────────────────────────────────────────

async function getUserEmailByUserId(userId) {
  const resp = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    { headers: svcHeaders() }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('[email] getUserEmailByUserId falhou: ' + err);
  }
  const data = await resp.json();
  return data?.email || null;
}

async function getUserEmailByCustomerId(customerId) {
  // Resolve customer_id → user_id via user_preferences, depois busca email no auth.users
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/user_preferences?asaas_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id`,
    { headers: svcHeaders() }
  );
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('[email] getUserEmailByCustomerId/preferences falhou: ' + err);
  }
  const rows = await resp.json();
  const userId = rows?.[0]?.user_id;
  if (!userId) return null;
  return getUserEmailByUserId(userId);
}

// ── Template: "Pagamento confirmado" ─────────────────────────────────────────

function buildPlanoAtivadoHtml({ planoNome, planoValidadeStr, valorStr }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pagamento confirmado · seu plano está ativo</title>
</head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f4f0;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="padding:32px 32px 0 32px;">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#7c5cdb;letter-spacing:-0.5px;">Pallyum</div>
</td></tr>
<tr><td style="padding:24px 32px 8px 32px;">
<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:600;line-height:1.2;color:#1a1a1a;">Pagamento confirmado</h1>
<p style="margin:12px 0 0 0;font-size:15px;color:#666;line-height:1.5;">Recebemos seu pagamento. Seu plano <strong style="color:#1a1a1a;">${planoNome}</strong> está ativo a partir de agora.</p>
</td></tr>
<tr><td style="padding:24px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f9f8f5;border:1px solid #ebe9e3;border-radius:10px;">
<tr><td style="padding:14px 18px;font-size:13px;color:#888;width:120px;">Plano</td><td style="padding:14px 18px;font-size:14px;color:#1a1a1a;font-weight:500;">${planoNome}</td></tr>
<tr><td style="padding:14px 18px;font-size:13px;color:#888;border-top:1px solid #ebe9e3;">Vigência até</td><td style="padding:14px 18px;font-size:14px;color:#1a1a1a;font-weight:500;border-top:1px solid #ebe9e3;">${planoValidadeStr}</td></tr>
<tr><td style="padding:14px 18px;font-size:13px;color:#888;border-top:1px solid #ebe9e3;">Valor pago</td><td style="padding:14px 18px;font-size:14px;color:#1a1a1a;font-weight:500;border-top:1px solid #ebe9e3;">R$ ${valorStr}</td></tr>
</table>
</td></tr>
<tr><td style="padding:8px 32px 32px 32px;text-align:center;">
<a href="https://www.pallyum.com/app" target="_blank" style="display:inline-block;padding:14px 36px;background:#7c5cdb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:500;">Acessar Pallyum</a>
</td></tr>
<tr><td style="padding:24px 32px 32px 32px;font-size:12px;color:#888;line-height:1.6;border-top:1px solid #ebe9e3;">
Esse e-mail é uma confirmação automática do seu pagamento. Você pode acessar o app e seu plano a qualquer momento.<br><br>
Pallyum é um produto da Somos Vast LTDA · <a href="https://pallyum.com" style="color:#888;text-decoration:underline;">pallyum.com</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── API pública ──────────────────────────────────────────────────────────────

async function sendPlanoAtivadoEmail({ toEmail, planoSlug, planoValidade, valor }) {
  if (!RESEND_API_KEY) {
    throw new Error('[email] RESEND_API_KEY não configurada');
  }
  if (!toEmail) {
    throw new Error('[email] toEmail obrigatório');
  }

  const planoNome = PLAN_DISPLAY_NAMES[planoSlug] || planoSlug;
  const planoValidadeStr = planoValidade
    ? new Date(planoValidade).toLocaleDateString('pt-BR')
    : 'indeterminada';
  const valorStr = (typeof valor === 'number')
    ? valor.toFixed(2).replace('.', ',')
    : String(valor || '');

  const html = buildPlanoAtivadoHtml({ planoNome, planoValidadeStr, valorStr });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    FROM_ADDRESS,
      to:      [toEmail],
      subject: 'Pagamento confirmado · seu plano está ativo',
      html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('[email] Resend API error (' + resp.status + '): ' + err);
  }

  return await resp.json();
}

// Wrappers de conveniência: resolvem o email e enviam.

export async function sendPlanoAtivadoByUserId({ userId, planoSlug, planoValidade, valor }) {
  const email = await getUserEmailByUserId(userId);
  if (!email) {
    throw new Error('[email] email não encontrado para userId=' + userId);
  }
  return sendPlanoAtivadoEmail({ toEmail: email, planoSlug, planoValidade, valor });
}

export async function sendPlanoAtivadoByCustomerId({ customerId, planoSlug, planoValidade, valor }) {
  const email = await getUserEmailByCustomerId(customerId);
  if (!email) {
    throw new Error('[email] email não encontrado para customerId=' + customerId);
  }
  return sendPlanoAtivadoEmail({ toEmail: email, planoSlug, planoValidade, valor });
}

// ── Template: "Confirme seu email secundário" ────────────────────────────────

function buildConfirmacaoEmailSecundarioHtml({ confirmationUrl, primaryEmailMascarado }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Adicionaram seu e-mail no Pallyum</title>
</head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f4f0;padding:40px 20px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="padding:32px 32px 0 32px;">
<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:600;color:#7c5cdb;letter-spacing:-0.5px;">Pallyum</div>
</td></tr>
<tr><td style="padding:24px 32px 8px 32px;">
<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:600;line-height:1.3;color:#1a1a1a;">Adicionaram seu e-mail no Pallyum</h1>
<p style="margin:16px 0 0 0;font-size:15px;color:#444;line-height:1.6;">A pessoa logada como <strong style="color:#1a1a1a;">${primaryEmailMascarado}</strong> adicionou este endereço de e-mail à conta dela no Pallyum. Foi você?</p>
</td></tr>
<tr><td style="padding:24px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff8e6;border:1px solid #f0d97b;border-radius:10px;padding:18px;">
<tr><td style="font-size:13px;color:#7a5e00;line-height:1.55;">
<strong style="color:#5a4400;">Se foi você</strong>, clique no botão abaixo para confirmar. O link expira em <strong>24 horas</strong>.<br><br>
<strong style="color:#5a4400;">Se não foi você</strong>, simplesmente ignore este e-mail. Nada será vinculado à sua conta sem essa confirmação.
</td></tr>
</table>
</td></tr>
<tr><td style="padding:8px 32px 32px 32px;text-align:center;">
<a href="${confirmationUrl}" target="_blank" style="display:inline-block;padding:14px 36px;background:#7c5cdb;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:500;">Confirmar e-mail</a>
</td></tr>
<tr><td style="padding:24px 32px 32px 32px;font-size:12px;color:#888;line-height:1.6;border-top:1px solid #ebe9e3;">
Pallyum é um produto da Somos Vast LTDA · <a href="https://pallyum.com" style="color:#888;text-decoration:underline;">pallyum.com</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function mascaraEmail(email) {
  if (!email || typeof email !== 'string') return '***';
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  const userVisible = user.length <= 2 ? user[0] + '*' : user.slice(0, 2) + '*'.repeat(Math.max(1, user.length - 2));
  return userVisible + '@' + domain;
}

export async function sendConfirmacaoEmailSecundario({ toEmail, confirmationUrl, primaryEmail }) {
  if (!RESEND_API_KEY) {
    throw new Error('[email] RESEND_API_KEY não configurada');
  }
  if (!toEmail || !confirmationUrl) {
    throw new Error('[email] toEmail e confirmationUrl obrigatórios');
  }

  const primaryEmailMascarado = mascaraEmail(primaryEmail);
  const html = buildConfirmacaoEmailSecundarioHtml({ confirmationUrl, primaryEmailMascarado });

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    FROM_ADDRESS,
      to:      [toEmail],
      subject: 'Adicionaram seu e-mail no Pallyum · confirme se foi você',
      html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('[email] Resend API error (' + resp.status + '): ' + err);
  }

  return await resp.json();
}
