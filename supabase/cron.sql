-- Rode uma vez no SQL Editor do Supabase, depois de publicar a função send-reminders.
-- Troque os dois valores marcados abaixo.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://SEU-PROJETO.supabase.co', 'project_url');   -- << URL do projeto
select vault.create_secret('MESMO-VALOR-DO-CRON_SECRET', 'cron_secret');         -- << segredo da função

select cron.schedule('meu-semestre-avisos', '*/15 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
$$);

-- Limpa o registro de avisos com mais de 60 dias, todo domingo às 4h (UTC)
select cron.schedule('meu-semestre-limpeza', '0 4 * * 0', $$
  delete from public.notification_log where sent_at < now() - interval '60 days';
$$);
