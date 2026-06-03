# Pallyum — instruções do projeto (Claude Code)

## Projeto
SaaS B2C brasileiro. Owner solo: Leandro (Somos Vast LTDA). Pré-PMF.
Stack: Node.js 22 · Vercel (serverless API routes em `/api`) · Supabase (Postgres + Auth + Storage) · Vanilla JS/HTML (frontend em `app.html`, sem framework) · Anthropic API (Claude Haiku 4.5 / Sonnet 4.6, roteamento por plano) · OpenAI API (embeddings `text-embedding-3-small` para RAG) · Twilio (WhatsApp Business) · Asaas (billing/pagamentos BR) · Google OAuth2 (Calendar + Gmail) · Resend (e-mail transacional)

## Como trabalhamos
- Você edita e SEMPRE descreve, em PT-BR claro, o que mudou e o que precisa ser testado. Nunca declare algo como "pronto" ou "funcionando" — quem valida não é quem edita.
- O owner não programa: ele leva sua saída de volta pra conversa que pediu (que valida) e cuida do deploy/GitHub.
- PT-BR. Direto, sem bajulação.
- Roadmap sequencial: Etapa 01 (pendências) → 02 (chat web tool use) → 03 (Nylas) → 04 (plano inativo). Sem trabalho em paralelo.

## Regras invioláveis
- LGPD primeiro: ao tocar em dado de usuário, sinalize a implicação ANTES de editar.
- Respeite blocos marcados [CUIDADO] no prompt — não toque no que for listado ali.
- Nunca commite segredos/API keys/tokens.
- Mudança de produto/feature não se decide aqui — só execução do que foi pedido.

## Convenções
- Timezone canônico: America/Sao_Paulo.
- Telefone canônico BR E.164: +55 + DDD + 9 + 8 dígitos (helper normalizePhone).
