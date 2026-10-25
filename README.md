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
| Telas (HTML, CSS e JavaScript, sem framework) | `src/`, publicado no GitHub Pages pelo workflow `.github/workflows/deploy.yml` |
| Login, banco Postgres com RLS | Supabase, `supabase/migrations/` |
| Avisos | Edge Function `supabase/functions/send-reminders`, chamada pelo `pg_cron` a cada 15 min |
| Funciona offline e recebe push | `public/sw.js` |

Cada tabela tem `user_id` e política de RLS, então cada conta só vê os próprios dados.
As chaves de push e o segredo do cron ficam no Vault do Supabase (veja o comentário em
`supabase/migrations/20261025000200_segredos_e_cron.sql`); nada secreto fica no repositório.
O `.env.production` só tem valores públicos.

## Rodar no computador

```bash
npm install
npm run dev      # usa o .env.production se não houver .env.local
npm test         # testa o cálculo de notas
```

## Publicar

Cada push na `main` testa, gera o site e publica no GitHub Pages
(precisa estar ligado uma vez em Settings → Pages → Source: **GitHub Actions**).
No Supabase, o endereço do site precisa estar em Authentication → URL Configuration
(**Site URL**), senão o link de confirmação do e-mail não volta para o app.

Para testar os avisos, rode no SQL Editor:

```sql
select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
  headers := jsonb_build_object('Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
  body := '{"test": true}'::jsonb);
```

## iPhone

Os avisos só chegam com o app instalado: abra no Safari, toque em Compartilhar → **Adicionar à Tela de Início**, abra pelo ícone e ative as notificações em Ajustes (precisa de iOS 16.4 ou mais novo).
