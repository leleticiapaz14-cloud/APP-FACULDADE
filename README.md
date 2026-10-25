# Meu Semestre

App pessoal para a faculdade, feito para usar no celular (PWA, instala na Tela de Início):

- **Frequência:** registra presença e falta por matéria e mostra quantas faltas ainda cabem no mínimo de presença (75% por padrão).
- **Estudo:** meta semanal de horas por matéria, cronômetro e gráfico da semana.
- **Notas:** você escreve a conta do professor (ex.: `0,35*P1 + 0,35*P2 + 0,3*Trabalho`) e as regras de aprovação; o app calcula a média e quanto precisa tirar.
- **Calendário:** provas, trabalhos e seminários com contagem regressiva.
- **Avisos push:** prova chegando (3 dias, 1 dia e no dia), meta de estudo atrasada (sexta 18h e domingo 15h) e "Você foi na aula?" logo depois de cada aula.

## Como funciona

| Parte | Onde |
| --- | --- |
| Telas (HTML, CSS e JavaScript, sem framework) | `src/`, publicado na Vercel |
| Login, banco Postgres com RLS | Supabase, `supabase/migrations/` |
| Avisos | Edge Function `supabase/functions/send-reminders`, chamada pelo `pg_cron` a cada 15 min |
| Funciona offline e recebe push | `public/sw.js` |

Cada tabela tem `user_id` e política de RLS, então cada conta só vê os próprios dados.

## Rodar no computador

```bash
npm install
cp .env.example .env.local   # preencha com os dados do Supabase
npm run dev
npm test                     # testa o cálculo de notas
```

## Configuração do Supabase (uma vez)

1. Aplique a migração `supabase/migrations/20261025000000_inicial.sql`.
2. Gere as chaves de push: `npx web-push generate-vapid-keys`.
3. Publique a função e defina os segredos:
   ```bash
   supabase functions deploy send-reminders
   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:seu@email \
     CRON_SECRET=um-texto-aleatorio APP_URL=https://seu-app.vercel.app
   ```
4. Rode `supabase/cron.sql` no SQL Editor (troque os dois valores marcados).
5. Em Authentication → URL Configuration, coloque o endereço da Vercel em **Site URL** e em **Redirect URLs**.

Para testar o envio: `curl -X POST "$SUPABASE_URL/functions/v1/send-reminders" -H "x-cron-secret: $CRON_SECRET" -d '{"test":true}'`.

## Publicar na Vercel

Importe o repositório na Vercel (framework: Vite) e defina as variáveis `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` e `VITE_VAPID_PUBLIC_KEY`. Cada push na `main` publica de novo.

## iPhone

Os avisos só chegam com o app instalado: abra no Safari, toque em Compartilhar → **Adicionar à Tela de Início**, abra pelo ícone e ative as notificações em Ajustes (precisa de iOS 16.4 ou mais novo).
