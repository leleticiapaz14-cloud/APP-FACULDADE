-- Segredos ficam no Vault (criados uma vez à mão, nunca no git):
--   select vault.create_secret('<chave pública VAPID>',  'vapid_public_key');
--   select vault.create_secret('<chave privada VAPID>',  'vapid_private_key');
--   select vault.create_secret('<texto aleatório>',      'cron_secret');
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');

-- Lê segredos do Vault; só a Edge Function (service_role) pode chamar
create function public.app_secrets() returns jsonb
language sql security definer set search_path = '' stable as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb)
  from vault.decrypted_secrets
  where name in ('vapid_public_key', 'vapid_private_key', 'cron_secret');
$$;
revoke execute on function public.app_secrets() from public, anon, authenticated;
grant execute on function public.app_secrets() to service_role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Chama a função de avisos a cada 15 minutos
select cron.schedule('meu-semestre-avisos', '*/15 * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
$cron$);

-- Limpa o registro de avisos com mais de 60 dias, todo domingo às 4h (UTC)
select cron.schedule('meu-semestre-limpeza', '0 4 * * 0', $cron$
  delete from public.notification_log where sent_at < now() - interval '60 days';
$cron$);
