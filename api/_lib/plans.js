/**
 * Pallyum — Roteamento de planos, modelos e fair use
 * Fonte da verdade: Pallyum-Planos-e-Precos.md v1.0
 *
 * Catálogo reduzido em 01/06/2026: 4 planos ativos.
 * SKUs legados mantidos comentados abaixo de cada mapa — não remover.
 */

import { isAdmin } from './adminAuth.js';

// Asaas — para cancelar a assinatura recorrente de add-ons excedentes (03.4b).
const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

// ── Tabela de SKUs ─────────────────────────────────────────────────────────────
// FONTE ÚNICA de preço/plano do app. Chave: "{produto}-{tier}-{periodo}".
// Importada por api/asaas/checkout.js (cobrança) e pelos helpers de proration
// abaixo (Bloco C). Preço só muda aqui. SKU_NAMES (display) fica no checkout.js.
export const SKUS = {
  // Companion (mensal)
  'companion-essencial-mensal':       { value: 29.00,   plano: 'companion-essencial'       },
  'companion-pro-mensal':             { value: 59.00,   plano: 'companion-pro'             },
  'companion-ultra-mensal':           { value: 89.00,   plano: 'companion-ultra'           },
  // Companion (anual)
  'companion-essencial-anual':        { value: 300.00,  plano: 'companion-essencial'       },
  'companion-pro-anual':              { value: 600.00,  plano: 'companion-pro'             },
  'companion-ultra-anual':            { value: 900.00,  plano: 'companion-ultra'           },

  // Segundo Cérebro (mensal)
  'segundo-cerebro-essencial-mensal': { value: 59.00,   plano: 'segundo-cerebro-essencial' },
  'segundo-cerebro-pro-mensal':       { value: 99.00,   plano: 'segundo-cerebro-pro'       },
  'segundo-cerebro-ultra-mensal':     { value: 169.00,  plano: 'segundo-cerebro-ultra'     },
  // Segundo Cérebro (anual)
  'segundo-cerebro-essencial-anual':  { value: 600.00,  plano: 'segundo-cerebro-essencial' },
  'segundo-cerebro-pro-anual':        { value: 1000.00, plano: 'segundo-cerebro-pro'       },
  'segundo-cerebro-ultra-anual':      { value: 1700.00, plano: 'segundo-cerebro-ultra'     },

  // Coletivo (mensal)
  'coletivo-team-mensal':             { value: 399.00,  plano: 'coletivo-team'             },
  'coletivo-business-mensal':         { value: 699.00,  plano: 'coletivo-business'         },
  // Coletivo (anual)
  'coletivo-team-anual':              { value: 4000.00, plano: 'coletivo-team'             },
  'coletivo-business-anual':          { value: 7000.00, plano: 'coletivo-business'         },

  // Duo Essencial
  'duo-essencial-mensal':             { value: 79.00,   plano: 'duo-essencial'             },
  'duo-essencial-anual':              { value: 790.00,  plano: 'duo-essencial'             },
  // Duo Pro
  'duo-pro-mensal':                   { value: 139.00,  plano: 'duo-pro'                   },
  'duo-pro-anual':                    { value: 1390.00, plano: 'duo-pro'                   },
  // Duo Ultra
  'duo-ultra-mensal':                 { value: 229.00,  plano: 'duo-ultra'                 },
  'duo-ultra-anual':                  { value: 2290.00, plano: 'duo-ultra'                 },

  // Novo catálogo Pallyum (01/06/2026)
  'essencial-mensal':                 { value:  39.00,  plano: 'essencial'                 },
  'pro-mensal':                       { value:  69.00,  plano: 'pro'                       },
  'ultra-mensal':                     { value:  99.00,  plano: 'ultra'                     },
};

export function dataHojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}
function dataSPdiasAtras(dias) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' })
    .format(new Date(Date.now() - dias * 86400000));
}

// ─────────────────────────────────────────────────────────────────────────────
// Bloco C — classificação e proration de troca de plano (mensal)
//
// Ambos os helpers usam SKUS[`${plano}-mensal`].value como fonte de preço.
// classifyPlanChange  → 'same' | 'upgrade' | 'downgrade' | null (sku desconhecido)
// prorationDiff       → { diff, chargeWaived }  (só relevante p/ upgrade)
// ─────────────────────────────────────────────────────────────────────────────

const PRORATION_FLOOR = 5; // abaixo disso, não vale a pena cobrar a diferença

function planoPriceMensal(plano) {
  const sku = SKUS[`${plano}-mensal`];
  return sku ? sku.value : null;
}

// classifyPlanChange(currentPlano, targetPlano)
//   Compara os preços mensais e classifica a transição.
//   Retorna null se algum dos planos não tiver SKU mensal conhecido.
export function classifyPlanChange(currentPlano, targetPlano) {
  const priceCurrent = planoPriceMensal(currentPlano);
  const priceTarget  = planoPriceMensal(targetPlano);
  if (priceCurrent == null || priceTarget == null) return null;
  if (priceTarget === priceCurrent) return 'same';
  return priceTarget > priceCurrent ? 'upgrade' : 'downgrade';
}

// prorationDiff({ currentPlano, targetPlano, nextDueDate })
//   Diferença pró-rata a cobrar HOJE num upgrade, proporcional aos dias que
//   faltam até a próxima cobrança (nextDueDate, 'YYYY-MM-DD' do Asaas).
//   Retorna null se algum plano for desconhecido.
//   Para downgrade/same o diff sai 0/≤0 e o chamador deve ignorá-lo.
export function prorationDiff({ currentPlano, targetPlano, nextDueDate }) {
  const priceCurrent = planoPriceMensal(currentPlano);
  const priceTarget  = planoPriceMensal(targetPlano);
  if (priceCurrent == null || priceTarget == null) return null;

  const gap = priceTarget - priceCurrent;

  // remainingDays = dias de hoje (SP) até nextDueDate, arredondado p/ cima, [0,30].
  const msPerDay = 86400000;
  const start = new Date(dataHojeSP() + 'T00:00:00-03:00').getTime();
  const end   = new Date(String(nextDueDate).slice(0, 10) + 'T00:00:00-03:00').getTime();
  let remainingDays = Math.ceil((end - start) / msPerDay);
  if (!Number.isFinite(remainingDays)) remainingDays = 0;
  remainingDays = Math.max(0, Math.min(30, remainingDays));

  // diff proporcional, 2 casas; trava: nunca > gap, nunca < 0.
  let diff = Math.round((gap * remainingDays / 30) * 100) / 100;
  if (diff > gap) diff = gap;
  if (diff < 0)   diff = 0;

  return { diff, chargeWaived: (diff > 0 && diff < PRORATION_FLOOR) };
}

// ── Parser de SKU → { plano, meses } ─────────────────────────────────────────
// Fonte única (movido de api/asaas/webhook.js). externalReference = "userId|sku".
// Ex: "abc123|companion-pro-mensal"  →  { plano: 'companion-pro', meses: 1 }
//     "abc123|segundo-cerebro-ultra-anual" → { plano: 'segundo-cerebro-ultra', meses: 12 }
// Retorna null se o SKU não tiver período (-mensal/-anual) ou plano desconhecido.
export function parsePlanFromSku(sku) {
  if (!sku) return null;

  const isAnual = sku.endsWith('-anual');
  const isMensal = sku.endsWith('-mensal');
  if (!isAnual && !isMensal) return null;

  const meses = isAnual ? 12 : 1;
  const plano = isAnual ? sku.slice(0, -6) : sku.slice(0, -7); // remove '-anual' ou '-mensal'

  const PLANOS_VALIDOS = [
    'companion-essencial', 'companion-pro', 'companion-ultra',
    'segundo-cerebro-essencial', 'segundo-cerebro-pro', 'segundo-cerebro-ultra',
    'coletivo-team', 'coletivo-business', 'coletivo-enterprise',
    'duo-essencial', 'duo-pro', 'duo-ultra',
    // Novo catálogo Pallyum (01/06/2026)
    'essencial', 'pro', 'ultra',
  ];
  if (!PLANOS_VALIDOS.includes(plano)) {
    console.warn(`ASAAS WEBHOOK: plano "${plano}" não reconhecido (sku=${sku})`);
    return null;
  }

  return { plano, meses };
}

// ── Mapeamento de plano → modelo Claude ──────────────────────
//
// Nota: 'pro', 'ultra' e 'design_partner' são planos de modelo dual:
//   - Haiku 4.5 para mensagens de rotina
//   - Sonnet 4.6 para raciocínio crítico
// MODEL_MAP registra o teto (Sonnet); o roteamento fino por tipo de tarefa
// é responsabilidade do MCP server que chama getModelForUser().
export const MODEL_MAP = {
  'essencial':      'claude-haiku-4-5',
  'pro':            'claude-sonnet-4-6',
  'ultra':          'claude-sonnet-4-6',
  'design_partner': 'claude-sonnet-4-6', // interno — features idênticas ao pro
};
const DEFAULT_MODEL = 'claude-haiku-4-5';
const SONNET_MODEL  = 'claude-sonnet-4-6';

// routeModel(ceilingModel, opts) — roteamento fino por tipo de tarefa (G-28).
// Só rebaixa AÇÃO (vira tool call + confirmação de texto fixo) quando o teto é Sonnet;
// nunca sobe; quem já é Haiku (Essencial) não muda; pergunta/redação fica no Sonnet.
export function routeModel(ceilingModel, opts) {
  const isAction = opts && opts.isAction;
  if (isAction && ceilingModel === SONNET_MODEL) return DEFAULT_MODEL; // ação rotineira → Haiku
  return ceilingModel;                                                 // senão, mantém o teto
}

// === SKUs legados desativados em 01/06/2026 — manter pra reativação futura ===
// 'companion-teste':           'claude-sonnet-4-6',
// 'companion-essencial':       'claude-haiku-4-5',
// 'companion-pro':             'claude-sonnet-4-6',
// 'companion-ultra':           'claude-sonnet-4-6',
// 'segundo-cerebro-essencial': 'claude-haiku-4-5',
// 'segundo-cerebro-pro':       'claude-sonnet-4-6',
// 'segundo-cerebro-ultra':     'claude-opus-4-7',
// 'coletivo-team':             'claude-sonnet-4-6',
// 'coletivo-business':         'claude-opus-4-7',
// 'coletivo-enterprise':       'claude-opus-4-7',
// 'duo-essencial':             'claude-haiku-4-5',
// 'duo-pro':                   'claude-sonnet-4-6',
// 'duo-ultra':                 'claude-opus-4-7',
// =============================================================================

// ── Mapeamento de plano → features ───────────────────────────
//
// audio    = Whisper habilitado
// vision   = análise de imagem habilitada
// briefing = briefing matinal habilitado          ← adicionado em 01/06/2026
// priority = prioridade de fila habilitada        ← adicionado em 01/06/2026
// internal = plano interno, não vendido via Asaas ← adicionado em 01/06/2026
//
// Storage e memória são quotas de infra, não flags booleanas:
//   essencial      → 2 GB  / memória 90 dias
//   pro            → 10 GB / memória permanente
//   ultra          → 25 GB / memória permanente
//   design_partner → 10 GB / memória permanente (igual ao pro)
export const FEATURE_MAP = {
  'essencial':      { audio: false, vision: false, briefing: false, priority: false, internal: false },
  'pro':            { audio: true,  vision: false, briefing: true,  priority: false, internal: false },
  'ultra':          { audio: true,  vision: true,  briefing: true,  priority: true,  internal: false },
  'design_partner': { audio: true,  vision: false, briefing: true,  priority: false, internal: true  },
};
const DEFAULT_FEATURES = { audio: false, vision: false, briefing: false, priority: false, internal: false };

// === SKUs legados desativados em 01/06/2026 — manter pra reativação futura ===
// 'companion-teste':           { audio: false, vision: false },
// 'companion-essencial':       { audio: false, vision: false },
// 'companion-pro':             { audio: true,  vision: false },
// 'companion-ultra':           { audio: true,  vision: true  },
// 'segundo-cerebro-essencial': { audio: true,  vision: false },
// 'segundo-cerebro-pro':       { audio: true,  vision: true  },
// 'segundo-cerebro-ultra':     { audio: true,  vision: true  },
// 'coletivo-team':             { audio: true,  vision: true  },
// 'coletivo-business':         { audio: true,  vision: true  },
// 'coletivo-enterprise':       { audio: true,  vision: true  },
// 'duo-essencial':             { audio: true,  vision: false },
// 'duo-pro':                   { audio: true,  vision: true  },
// 'duo-ultra':                 { audio: true,  vision: true  },
// =============================================================================

// ── Tabela de cooldown por faixa de uso (seção 9.2) ──────────
// [ limiteInferior, limiteExclusivo, delayMs ]
const COOLDOWN_TABLE = [
  [0,    100,  0     ],
  [100,  150,  500   ],
  [150,  200,  1500  ],
  [200,  290,  3000  ],
  [290,  500,  5000  ],
  [500,  800,  8000  ],
  [800,  1000, 15000 ],
];
const SUSPENSION_THRESHOLD_DAILY = 1000;
const SUSPENSION_DAYS_CONSECUTIVE = 3;

// ── Helpers internos ─────────────────────────────────────────
function cooldownFromAvg(avg) {
  for (const [lo, hi, ms] of COOLDOWN_TABLE) {
    if (avg >= lo && avg < hi) return ms;
  }
  return 15000; // >= 1000 msg/dia
}

// ── Supabase factory (lazy) ───────────────────────────────────
function makeSupabase() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ─────────────────────────────────────────────────────────────
// getModelForUser(userId) → string
//   Consulta user_preferences.plano e retorna o modelo Claude.
// ─────────────────────────────────────────────────────────────
export async function getModelForUser(userId) {
  try {
    const sb = makeSupabase();
    const { data } = await sb
      .from('user_preferences')
      .select('plano')
      .eq('user_id', userId)
      .maybeSingle();
    const plano = data?.plano || '';
    return MODEL_MAP[plano] || DEFAULT_MODEL;
  } catch (e) {
    console.error('getModelForUser error:', e.message);
    return DEFAULT_MODEL;
  }
}

// ─────────────────────────────────────────────────────────────
// getFeaturesForUser(userId) → { audio, vision, briefing, priority, internal }
// ─────────────────────────────────────────────────────────────
export async function getFeaturesForUser(userId) {
  try {
    const sb = makeSupabase();
    const { data } = await sb
      .from('user_preferences')
      .select('plano')
      .eq('user_id', userId)
      .maybeSingle();
    const plano = data?.plano || '';
    return FEATURE_MAP[plano] || DEFAULT_FEATURES;
  } catch (e) {
    console.error('getFeaturesForUser error:', e.message);
    return DEFAULT_FEATURES;
  }
}

// ── Limite de contas de calendário conectadas por plano (03.4) ───────────────
// Total = google_tokens + nylas_grants ativos. Admin e design_partner (internal)
// não têm limite. Email avulso (+R$15) é 03.4b — fora daqui.
export const MAX_ACCOUNTS = { essencial: 1, pro: 2, ultra: 3 };

export async function checkAccountLimit(uid) {
  // Bypass admin (uid fixo): nunca vê limite.
  if (isAdmin(uid)) {
    let plano = '';
    try {
      const sb = makeSupabase();
      const { data } = await sb.from('user_preferences').select('plano').eq('user_id', uid).maybeSingle();
      plano = data?.plano || '';
    } catch (e) { console.error('checkAccountLimit admin plano error:', e.message); }
    return { plano, used: null, max: null, atLimit: false, isAdmin: true, isDP: false, bypass: 'admin' };
  }

  const sb = makeSupabase();

  // Plano atual.
  let plano = '';
  try {
    const { data } = await sb.from('user_preferences').select('plano').eq('user_id', uid).maybeSingle();
    plano = data?.plano || '';
  } catch (e) { console.error('checkAccountLimit plano error:', e.message); }

  // Bypass design_partner (FEATURE_MAP[...].internal === true).
  const isDP = !!(FEATURE_MAP[plano] && FEATURE_MAP[plano].internal);
  if (isDP) {
    return { plano, used: null, max: null, atLimit: false, isAdmin: false, isDP: true, bypass: 'dp' };
  }

  // Conta contas conectadas (Google + Nylas ativos).
  let gCount = 0, nCount = 0;
  try {
    const { count } = await sb.from('google_tokens').select('id', { count: 'exact', head: true }).eq('user_id', uid);
    gCount = count || 0;
  } catch (e) { console.error('checkAccountLimit google count error:', e.message); }
  try {
    const { count } = await sb.from('nylas_grants').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'active');
    nCount = count || 0;
  } catch (e) { console.error('checkAccountLimit nylas count error:', e.message); }

  const used = gCount + nCount;

  // Add-ons pagos (e-mail avulso +R$15/mês, 03.4b): cada um soma +1 ao limite.
  let paidAddOns = 0;
  try {
    const { count } = await sb.from('account_addons').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'active');
    paidAddOns = count || 0;
  } catch (e) { console.error('checkAccountLimit addons count error:', e.message); paidAddOns = 0; }

  const max = (MAX_ACCOUNTS[plano] != null ? MAX_ACCOUNTS[plano] : 1) + paidAddOns;
  return { plano, used, max, atLimit: used >= max, isAdmin: false, isDP: false };
}

// ── Sync de add-ons após remover uma conta (03.4b) ───────────────────────────
// Quando o usuário remove uma conta conectada, pode haver add-ons pagos que
// deixaram de ser necessários (used caiu). Cancela os add-ons EXCEDENTES: para
// cada um, DELETE da assinatura recorrente no Asaas (best-effort) + marca a
// linha como 'canceled'. Mantém os que ainda cobrem uso acima do tier.
export async function syncAddOnsAfterRemoval(uid) {
  try {
    const sb = makeSupabase();

    // Plano atual.
    let plano = '';
    try {
      const { data } = await sb.from('user_preferences').select('plano').eq('user_id', uid).maybeSingle();
      plano = data?.plano || '';
    } catch (e) { console.error('syncAddOns plano error:', e.message); }

    // used = contas conectadas (Google + Nylas ativos), recomputado AGORA.
    let gCount = 0, nCount = 0;
    try {
      const { count } = await sb.from('google_tokens').select('id', { count: 'exact', head: true }).eq('user_id', uid);
      gCount = count || 0;
    } catch (e) { console.error('syncAddOns google count error:', e.message); }
    try {
      const { count } = await sb.from('nylas_grants').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'active');
      nCount = count || 0;
    } catch (e) { console.error('syncAddOns nylas count error:', e.message); }
    const used = gCount + nCount;

    const tierMax = MAX_ACCOUNTS[plano] != null ? MAX_ACCOUNTS[plano] : 1;
    const needed  = Math.max(0, used - tierMax); // add-ons ainda justificados pelo uso

    // Add-ons ativos (mais antigos primeiro).
    let addons = [];
    try {
      const { data } = await sb.from('account_addons')
        .select('id, asaas_subscription_id')
        .eq('user_id', uid).eq('status', 'active')
        .order('created_at', { ascending: true });
      addons = Array.isArray(data) ? data : [];
    } catch (e) { console.error('syncAddOns read addons error:', e.message); return; }

    const surplus = Math.max(0, addons.length - needed);
    if (surplus === 0) {
      console.log(`syncAddOns | uid=${uid} | used=${used} tierMax=${tierMax} needed=${needed} | ativos=${addons.length} | nada a cancelar`);
      return;
    }

    let canceled = 0;
    for (let k = 0; k < surplus; k++) {
      const addon = addons[k];
      // 1) Cancela a assinatura recorrente no Asaas (best-effort; 404 = já não existe).
      if (addon.asaas_subscription_id) {
        try {
          const r = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(addon.asaas_subscription_id)}`, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
          });
          if (!r.ok && r.status !== 404) {
            console.error('syncAddOns: DELETE subscription Asaas falhou (segue):', addon.asaas_subscription_id, r.status);
          }
        } catch (e) { console.error('syncAddOns: DELETE subscription erro (segue):', e.message); }
      }
      // 2) Marca a linha como cancelada.
      try {
        const { error } = await sb.from('account_addons')
          .update({ status: 'canceled', canceled_at: new Date().toISOString() })
          .eq('id', addon.id);
        if (error) console.error('syncAddOns: update account_addons falhou:', error.message);
        else canceled++;
      } catch (e) { console.error('syncAddOns: update account_addons erro:', e.message); }
    }
    console.log(`syncAddOns | uid=${uid} | used=${used} tierMax=${tierMax} needed=${needed} | ativos=${addons.length} cancelados=${canceled}`);
  } catch (e) {
    console.error('syncAddOnsAfterRemoval error:', e.message);
  }
}

// ── Vision — fair use mensal (Etapa de Urgência, 06/2026) ─────
// Cota de imagens processadas por Vision, por mês-calendário (America/Sao_Paulo).
// Decisão 08/06: Essencial sem · Pro 120 · Ultra 300 · design_partner = volume do Pro.
export const VISION_QUOTA = {
  'essencial':      0,
  'pro':            120,
  'ultra':          300,
  'design_partner': 120,
};
const DEFAULT_VISION_QUOTA = 0;

// 'YYYY-MM' no fuso de Brasília — chave da janela mensal do vision_usage.
export function getVisionMonth() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
  }).format(new Date()).slice(0, 7);
}

// checkVisionQuota(userId) → { allowed, count, quota, plano, month }. Não incrementa.
// Fail-closed: em erro, allowed=false (protege custo; sem usuários reais ainda).
export async function checkVisionQuota(userId) {
  const month = getVisionMonth();
  try {
    const sb = makeSupabase();
    const { data: prefs } = await sb
      .from('user_preferences')
      .select('plano')
      .eq('user_id', userId)
      .maybeSingle();
    const plano = prefs?.plano || '';
    const quota = Object.prototype.hasOwnProperty.call(VISION_QUOTA, plano)
      ? VISION_QUOTA[plano]
      : DEFAULT_VISION_QUOTA;

    const { data: usage } = await sb
      .from('vision_usage')
      .select('count')
      .eq('user_id', userId)
      .eq('year_month', month)
      .maybeSingle();
    const count = usage?.count || 0;

    return { allowed: quota > 0 && count < quota, count, quota, plano, month };
  } catch (e) {
    console.error('checkVisionQuota error:', e.message);
    return { allowed: false, count: 0, quota: 0, plano: '', month };
  }
}

// incrementVisionUsage(userId) → novo total (int) | null.
// Chama a RPC atômica increment_vision_usage. Usar SÓ após inferência bem-sucedida.
export async function incrementVisionUsage(userId) {
  const month = getVisionMonth();
  try {
    const sb = makeSupabase();
    const { data, error } = await sb.rpc('increment_vision_usage', {
      p_user_id: userId, p_year_month: month,
    });
    if (error) { console.error('incrementVisionUsage rpc error:', error.message); return null; }
    return data;
  } catch (e) {
    console.error('incrementVisionUsage error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// calculateCooldown(userId) → número em ms  |  'BLOCKED'
//   Calcula média rolante de 7 dias de mensagens e retorna o
//   delay apropriado. Retorna 'BLOCKED' se suspensão pendente.
// ─────────────────────────────────────────────────────────────
export async function calculateCooldown(userId) {
  try {
    const sb = makeSupabase();

    // Verificar suspensão pendente
    const { data: prefs } = await sb
      .from('user_preferences')
      .select('pending_suspension, current_cooldown_ms')
      .eq('user_id', userId)
      .maybeSingle();

    if (prefs?.pending_suspension) return 'BLOCKED';

    // Buscar últimos 7 dias de uso (data em horário de Brasília)
    const since = dataSPdiasAtras(7);

    const { data: logs } = await sb
      .from('usage_logs')
      .select('msg_count, date')
      .eq('user_id', userId)
      .gte('date', since);

    if (!logs || logs.length === 0) return 0;

    // Agrupa por data e soma canais
    const byDate = {};
    for (const row of logs) {
      byDate[row.date] = (byDate[row.date] || 0) + row.msg_count;
    }
    const totals = Object.values(byDate);
    const avg = totals.reduce((a, b) => a + b, 0) / 7; // divide por 7 dias

    return cooldownFromAvg(avg);
  } catch (e) {
    console.error('calculateCooldown error:', e.message);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// trackUsage(userId, channel, options)
//   Incrementa contadores em usage_logs para o dia atual.
//   channel: 'app' | 'whatsapp'
//   options: { audio?: bool, image?: bool, plano?: string }
// ─────────────────────────────────────────────────────────────
export async function trackUsage(userId, channel, options = {}) {
  try {
    const sb = makeSupabase();
    const today = dataHojeSP();

    // Buscar plano atual se não fornecido
    let planAtTime = options.plano || null;
    if (!planAtTime) {
      const { data } = await sb
        .from('user_preferences')
        .select('plano')
        .eq('user_id', userId)
        .maybeSingle();
      planAtTime = data?.plano || 'unknown';
    }

    // Upsert: incrementa contadores atomicamente
    const { error } = await sb.rpc('increment_usage', {
      p_user_id:    userId,
      p_date:       today,
      p_channel:    channel,
      p_plan:       planAtTime,
      p_audio:      options.audio  ? 1 : 0,
      p_image:      options.image  ? 1 : 0,
    });

    // Fallback: upsert manual se RPC não existir
    if (error && error.code === 'PGRST202') {
      const { data: existing } = await sb
        .from('usage_logs')
        .select('msg_count, audio_count, image_count')
        .eq('user_id', userId)
        .eq('date', today)
        .eq('channel', channel)
        .maybeSingle();

      await sb.from('usage_logs').upsert({
        user_id:      userId,
        date:         today,
        channel:      channel,
        plan_at_time: planAtTime,
        msg_count:    (existing?.msg_count   || 0) + 1,
        audio_count:  (existing?.audio_count || 0) + (options.audio ? 1 : 0),
        image_count:  (existing?.image_count || 0) + (options.image ? 1 : 0),
      }, { onConflict: 'user_id,date,channel' });
    }
  } catch (e) {
    // Nunca deixar o tracking quebrar a resposta ao usuário
    console.error('trackUsage error:', e.message);
  }
}

// ── Gate de plano ativo (Etapa 04 — lógica de plano inativo) ─────────────────
// Lock EXCLUSIVO por validade: cenários A (trial), B (DP 30d), C (falha recorrente).
// A string do plano NÃO muda. null/sem data → ATIVO (pré-pagamento/admin, não é
// "expirou"); data inválida → ATIVO (fail-open).
export function isPlanActiveFromValidade(planoValidade) {
  if (!planoValidade) return true;
  const t = new Date(planoValidade).getTime();
  if (!Number.isFinite(t)) return true;
  return t >= Date.now();
}

// Async por uid. ADMIN nunca expira (bypass). DP expira pela validade (cenário B).
// Erro de leitura → fail-open (true): não pune o pagante por soluço de banco; o
// bloqueio real persiste na próxima checagem.
export async function isPlanActive(uid) {
  try {
    if (isAdmin(uid)) return true;
    const sb = makeSupabase();
    const { data } = await sb.from('user_preferences').select('plano_validade').eq('user_id', uid).maybeSingle();
    return isPlanActiveFromValidade(data?.plano_validade);
  } catch (e) {
    console.error('isPlanActive error (fail-open):', e.message);
    return true;
  }
}

// ── Cancela TODOS os add-ons ativos de um usuário (Etapa 04.4a) ──────────────
// Usado quando o plano é cancelado: os add-ons (e-mails extras) não fazem sentido
// sem plano, e não podem seguir cobrando. Mesma mecânica provada do syncAddOnsAfterRemoval,
// mas cancela TODOS (não só o excedente). Best-effort: loga cada um, nunca lança.
export async function cancelAllAddOns(uid) {
  try {
    const sb = makeSupabase();
    let addons = [];
    try {
      const { data } = await sb.from('account_addons')
        .select('id, asaas_subscription_id')
        .eq('user_id', uid).eq('status', 'active');
      addons = Array.isArray(data) ? data : [];
    } catch (e) { console.error('cancelAllAddOns read error:', e.message); return 0; }

    let canceled = 0;
    for (const addon of addons) {
      if (addon.asaas_subscription_id) {
        try {
          const r = await fetch(`${ASAAS_BASE_URL}/subscriptions/${encodeURIComponent(addon.asaas_subscription_id)}`, {
            method:  'DELETE',
            headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_API_KEY },
          });
          if (!r.ok && r.status !== 404) {
            console.error('cancelAllAddOns: DELETE subscription Asaas falhou (segue):', addon.asaas_subscription_id, r.status);
          }
        } catch (e) { console.error('cancelAllAddOns: DELETE subscription erro (segue):', e.message); }
      }
      try {
        const { error } = await sb.from('account_addons')
          .update({ status: 'canceled', canceled_at: new Date().toISOString() })
          .eq('id', addon.id);
        if (error) console.error('cancelAllAddOns: update account_addons falhou:', error.message);
        else canceled++;
      } catch (e) { console.error('cancelAllAddOns: update account_addons erro:', e.message); }
    }
    console.log(`cancelAllAddOns | uid=${uid} | add-ons cancelados=${canceled}/${addons.length}`);
    return canceled;
  } catch (e) {
    console.error('cancelAllAddOns erro geral:', e.message);
    return 0;
  }
}

// Checa se um downgrade para targetPlano cabe nas contas conectadas (Etapa 04.4c, regra b).
// Capacidade no destino = MAX_ACCOUNTS[target] + add-ons ativos (os add-ons seguem após
// o downgrade). Se as contas conectadas excedem, o downgrade é bloqueado e o usuário
// desconecta o excedente que quiser. Fail-open em erro: não trava por glitch de banco.
export async function downgradeCapacityCheck(uid, targetPlano) {
  const out = { ok: true, used: 0, capacity: 0, excedente: 0 };
  try {
    const sb = makeSupabase();
    let gCount = 0, nCount = 0, addons = 0;
    try {
      const { count } = await sb.from('google_tokens').select('id', { count: 'exact', head: true }).eq('user_id', uid);
      gCount = count || 0;
    } catch (e) { console.error('downgradeCapacityCheck google error:', e.message); }
    try {
      const { count } = await sb.from('nylas_grants').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'active');
      nCount = count || 0;
    } catch (e) { console.error('downgradeCapacityCheck nylas error:', e.message); }
    try {
      const { count } = await sb.from('account_addons').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('status', 'active');
      addons = count || 0;
    } catch (e) { console.error('downgradeCapacityCheck addons error:', e.message); }
    const used = gCount + nCount;
    const tierMax = MAX_ACCOUNTS[targetPlano] != null ? MAX_ACCOUNTS[targetPlano] : 1;
    out.used = used;
    out.capacity = tierMax + addons;
    out.excedente = Math.max(0, used - out.capacity);
    out.ok = out.excedente === 0;
    return out;
  } catch (e) {
    console.error('downgradeCapacityCheck erro geral (fail-open):', e.message);
    return out; // ok=true → não bloqueia
  }
}

// Invariante de PRINCIPAL ÚNICA GLOBAL: zera is_primary nas DUAS tabelas de conta
// (google_tokens + nylas_grants) de um usuário. O caller marca a escolhida depois.
// Service-role (makeSupabase). Update sem match = no-op.
export async function clearAllPrimary(uid) {
  const sb = makeSupabase();
  await sb.from('google_tokens').update({ is_primary: false }).eq('user_id', uid);
  await sb.from('nylas_grants').update({ is_primary: false }).eq('user_id', uid);
}

// Existe ALGUMA conta principal do usuário, somando as DUAS tabelas? Usado pelo fluxo de
// CONEXÃO para só marcar a conta nova como principal quando é a 1ª do usuário (cross-table).
// Service-role (makeSupabase).
export async function hasAnyPrimary(uid) {
  const sb = makeSupabase();
  const g = await sb.from('google_tokens').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('is_primary', true);
  if (g.count && g.count > 0) return true;
  const n = await sb.from('nylas_grants').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('is_primary', true);
  return !!(n.count && n.count > 0);
}
