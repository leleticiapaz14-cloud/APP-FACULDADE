-- A função só deve rodar pelo gatilho de cadastro, não pela API
revoke execute on function public.handle_new_user() from public, anon, authenticated;
