/**
 * Pallyum — Confirmar email secundário (rota pública)
 *
 * GET /api/user-emails/confirm?token=XXX
 *
 * Valida o token e marca o email como confirmado. Não requer autenticação
 * (quem clica é o destinatário do email, possivelmente em outro dispositivo).
 *
 * Retorna HTML (não JSON) — é uma página acessada pelo navegador.
 */

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function svcHeaders() {
  return {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage({ titulo, corpo, accentColor }) {
  const cor = accentColor || '#7c5cdb';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titulo} · Pallyum</title>
<style>
  body { margin:0; padding:40px 20px; background:#f5f4f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1a1a1a; }
  .card { max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; padding:40px 32px; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,0.05); }
  .brand { font-family:Georgia,'Times New Roman',serif; font-size:22px; font-weight:600; color:#7c5cdb; letter-spacing:-0.5px; margin-bottom:24px; }
  .icon { font-size:48px; line-height:1; margin-bottom:16px; }
  h1 { margin:0 0 12px; font-family:Georgia,serif; font-size:24px; font-weight:600; color:${cor}; }
  p { margin:0; font-size:14px; color:#666; line-height:1.6; }
  .footer { margin-top:32px; font-size:11px; color:#888; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">Pallyum</div>
    ${corpo}
  </div>
  <div class="footer" style="text-align:center;">Pallyum é um produto da Somos Vast LTDA</div>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const token = (req.query?.token || '').toString().trim();

  if (!token) {
    return res.status(400).send(renderPage({
      titulo: 'Link inválido',
      accentColor: '#c84a4a',
      corpo: `
        <div class="icon">⚠️</div>
        <h1>Link inválido</h1>
        <p>Este link de confirmação está incompleto. Volte ao Pallyum e tente novamente.</p>
      `,
    }));
  }

  // Busca o registro pelo token
  let row;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?confirmation_token=eq.${encodeURIComponent(token)}&select=id,email,confirmed_at,confirmation_token_expires_at`,
      { headers: svcHeaders() }
    );
    const rows = await resp.json();
    row = Array.isArray(rows) ? rows[0] : null;
  } catch (e) {
    console.error('[user-emails/confirm] consulta falhou:', e.message);
    return res.status(500).send(renderPage({
      titulo: 'Erro',
      accentColor: '#c84a4a',
      corpo: `
        <div class="icon">⚠️</div>
        <h1>Algo deu errado</h1>
        <p>Não conseguimos validar agora. Tente novamente em alguns minutos.</p>
      `,
    }));
  }

  if (!row) {
    return res.status(404).send(renderPage({
      titulo: 'Link inválido',
      accentColor: '#c84a4a',
      corpo: `
        <div class="icon">⚠️</div>
        <h1>Link inválido ou já usado</h1>
        <p>Este link de confirmação não existe ou já foi usado. Se você ainda quer confirmar este e-mail, peça um novo link no Pallyum.</p>
      `,
    }));
  }

  if (row.confirmed_at) {
    return res.status(200).send(renderPage({
      titulo: 'Já confirmado',
      accentColor: '#7c5cdb',
      corpo: `
        <div class="icon">✓</div>
        <h1>E-mail já confirmado</h1>
        <p>O e-mail <strong>${escapeHtml(row.email)}</strong> já tinha sido confirmado anteriormente. Não precisa fazer nada.</p>
      `,
    }));
  }

  // Checa expiração
  const expiresAt = row.confirmation_token_expires_at ? new Date(row.confirmation_token_expires_at) : null;
  if (!expiresAt || expiresAt < new Date()) {
    // Expirado: deletamos o registro (lazy cleanup)
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/user_emails?id=eq.${encodeURIComponent(row.id)}`,
        { method: 'DELETE', headers: svcHeaders() }
      );
    } catch (e) {
      console.error('[user-emails/confirm] cleanup falhou:', e.message);
    }
    return res.status(410).send(renderPage({
      titulo: 'Link expirado',
      accentColor: '#c84a4a',
      corpo: `
        <div class="icon">⌛</div>
        <h1>Link expirado</h1>
        <p>Este link de confirmação venceu (links são válidos por 24h). Peça um novo no Pallyum, em Configurações → Meus emails.</p>
      `,
    }));
  }

  // Confirma
  try {
    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_emails?id=eq.${encodeURIComponent(row.id)}`,
      {
        method: 'PATCH',
        headers: svcHeaders(),
        body: JSON.stringify({
          confirmed_at:                  new Date().toISOString(),
          confirmation_token:            null,
          confirmation_token_expires_at: null,
        }),
      }
    );
    if (!updateRes.ok) {
      throw new Error(await updateRes.text());
    }
  } catch (e) {
    console.error('[user-emails/confirm] UPDATE falhou:', e.message);
    return res.status(500).send(renderPage({
      titulo: 'Erro',
      accentColor: '#c84a4a',
      corpo: `
        <div class="icon">⚠️</div>
        <h1>Algo deu errado</h1>
        <p>Não conseguimos confirmar agora. Tente novamente em alguns minutos.</p>
      `,
    }));
  }

  console.log(`[user-emails/confirm] OK | email=${escapeHtml(row.email)}`);

  return res.status(200).send(renderPage({
    titulo: 'E-mail confirmado',
    accentColor: '#3a9d6a',
    corpo: `
      <div class="icon">✓</div>
      <h1>E-mail confirmado</h1>
      <p>O e-mail <strong>${escapeHtml(row.email)}</strong> foi confirmado com sucesso e já está vinculado à conta. Pode fechar essa janela.</p>
    `,
  }));
}
