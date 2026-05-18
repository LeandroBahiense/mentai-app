/**
 * Pallyum — Roteamento de planos, modelos e fair use
 * Fonte da verdade: Pallyum-Planos-e-Precos.md v1.0
 */

// ── Mapeamento de plano → modelo Claude ──────────────────────
export const MODEL_MAP = {
  'companion-teste':           'claude-sonnet-4-6',
  'companion-essencial':       'claude-haiku-4-5',
  'companion-pro':             'claude-sonnet-4-6',
  'companion-ultra':           'claude-sonnet-4-6',
  'segundo-cerebro-essencial': 'claude-haiku-4-5',
  'segundo-cerebro-pro':       'claude-sonnet-4-6',
  'segundo-cerebro-ultra':     'claude-opus-4-7',
  'coletivo-team':             'claude-sonnet-4-6',
  'coletivo-business':         'claude-opus-4-7',
  'coletivo-enterprise':       'claude-opus-4-7',
  'duo-essencial':             'claude-haiku-4-5',
  'duo-pro':                   'claude-sonnet-4-6',
  'duo-ultra':                 'claude-opus-4-7',
};
const DEFAULT_MODEL = 'claude-haiku-4-5';

// ── Mapeamento de plano → features ───────────────────────────
// audio  = Whisper habilitado
// vision = análise de imagem habilitada
export const FEATURE_MAP = {
  'companion-teste':           { audio: false, vision: false },
  'companion-essencial':       { audio: false, vision: false },
  'companion-pro':             { audio: true,  vision: false },
  'companion-ultra':           { audio: true,  vision: true  },
  'segundo-cerebro-essencial': { audio: true,  vision: false },
  'segundo-cerebro-pro':       { audio: true,  vision: true  },
  'segundo-cerebro-ultra':     { audio: true,  vision: true  },
  'coletivo-team':             { audio: true,  vision: true  },
  'coletivo-business':         { audio: true,  vision: true  },
  'coletivo-enterprise':       { audio: true,  vision: true  },
  'duo-essencial':             { audio: true,  vision: false },
  'duo-pro':                   { audio: true,  vision: true  },
  'duo-ultra':                 { audio: true,  vision: true  },
};
const DEFAULT_FEATURES = { audio: false, vision: false };

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
// getFeaturesForUser(userId) → { audio: bool, vision: bool }
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

    // Buscar últimos 7 dias de uso
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = sevenDaysAgo.toISOString().split('T')[0];

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
    const today = new Date().toISOString().split('T')[0];

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
