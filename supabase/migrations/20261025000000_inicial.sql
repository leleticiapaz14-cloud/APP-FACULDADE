-- Meu Semestre: esquema inicial.
-- Cada tabela tem user_id e RLS, então cada pessoa só enxerga os próprios dados.

create extension if not exists pgcrypto;

-- Perfil e configurações do semestre
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '',
  semester_label text not null default '',
  semester_start date,
  semester_end date,
  timezone text not null default 'America/Sao_Paulo',
  min_attendance numeric not null default 0.75 check (min_attendance > 0 and min_attendance <= 1),
  notify_study boolean not null default true,
  notify_events boolean not null default true,
  notify_classes boolean not null default true,
  created_at timestamptz not null default now()
);

-- Matérias. days = dias da semana (0 = domingo ... 6 = sábado).
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  professor text not null default '',
  room text not null default '',
  color text not null default 's1',
  days smallint[] not null default '{}',
  start_time time,
  end_time time,
  total_classes integer not null default 0 check (total_classes >= 0),
  weekly_goal_minutes integer not null default 0 check (weekly_goal_minutes >= 0),
  grade_formula text not null default '',
  grade_components jsonb not null default '[]'::jsonb, -- [{ "n": "P1", "v": 7.5 | null }]
  rule_direct numeric not null default 7,
  rule_final numeric not null default 4,
  rule_final_pass numeric not null default 5,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index on public.subjects (user_id);

-- Uma linha por aula registrada (presença ou falta)
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id uuid not null references public.subjects on delete cascade,
  class_date date not null,
  present boolean not null,
  created_at timestamptz not null default now(),
  unique (subject_id, class_date)
);
create index on public.attendance (user_id);

-- Sessões de estudo (cronômetro ou lançadas à mão)
create table public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id uuid not null references public.subjects on delete cascade,
  started_at timestamptz not null default now(),
  minutes integer not null check (minutes > 0 and minutes <= 1440),
  created_at timestamptz not null default now()
);
create index on public.study_sessions (user_id, started_at);

-- Provas, trabalhos e seminários
create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  subject_id uuid references public.subjects on delete cascade,
  event_date date not null,
  type text not null check (type in ('prova', 'trabalho', 'seminario')),
  title text not null,
  note text not null default '',
  created_at timestamptz not null default now()
);
create index on public.events (user_id, event_date);

-- Aparelhos inscritos para receber notificações push
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  created_at timestamptz not null default now()
);
create index on public.push_subscriptions (user_id);

-- Registro do que já foi avisado, para não mandar a mesma notificação duas vezes
create table public.notification_log (
  user_id uuid not null references auth.users on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- RLS: dona dos dados lê e escreve só o que é dela
alter table public.profiles enable row level security;
alter table public.subjects enable row level security;
alter table public.attendance enable row level security;
alter table public.study_sessions enable row level security;
alter table public.events enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_log enable row level security;

create policy "perfil próprio" on public.profiles
  for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "matérias próprias" on public.subjects
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "frequência própria" on public.attendance
  for all to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.subjects s where s.id = subject_id and s.user_id = (select auth.uid())));

create policy "estudo próprio" on public.study_sessions
  for all to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.subjects s where s.id = subject_id and s.user_id = (select auth.uid())));

create policy "eventos próprios" on public.events
  for all to authenticated using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and (subject_id is null or exists (select 1 from public.subjects s where s.id = subject_id and s.user_id = (select auth.uid()))));

create policy "aparelhos próprios" on public.push_subscriptions
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- notification_log fica só para a Edge Function (service role), sem política para usuários.

-- Cria o perfil automaticamente no cadastro
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name) values (new.id, coalesce(new.raw_user_meta_data ->> 'name', ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
