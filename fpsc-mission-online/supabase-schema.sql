-- Run this entire file once in Supabase Dashboard -> SQL Editor -> New query.
-- The service-role key is used only by the Vercel serverless function. Never put it in index.html.

create table if not exists public.fpsc_daily_sets (
  set_date date not null,
  kind text not null check (kind in ('mcq','interview')),
  focus text not null,
  data jsonb not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (set_date, kind)
);

create table if not exists public.fpsc_daily_usage (
  usage_date date primary key,
  generations_used integer not null default 0 check (generations_used between 0 and 2),
  updated_at timestamptz not null default now()
);

create table if not exists public.fpsc_daily_jobs (
  set_date date not null,
  kind text not null check (kind in ('mcq','interview')),
  status text not null check (status in ('generating','done','failed','blocked')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (set_date, kind)
);

-- Keep browser clients from reading or changing the shared cache directly.
alter table public.fpsc_daily_sets enable row level security;
alter table public.fpsc_daily_usage enable row level security;
alter table public.fpsc_daily_jobs enable row level security;
revoke all on public.fpsc_daily_sets from anon, authenticated;
revoke all on public.fpsc_daily_usage from anon, authenticated;
revoke all on public.fpsc_daily_jobs from anon, authenticated;
grant all on public.fpsc_daily_sets to service_role;
grant all on public.fpsc_daily_usage to service_role;
grant all on public.fpsc_daily_jobs to service_role;

-- Atomically reserves one of two generation attempts per UTC day across ALL visitors.
-- Cached dates do not consume a generation slot. A generation in progress is shared.
create or replace function public.fpsc_claim_generation(p_target_date date, p_kind text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted date;
  v_status text;
  v_started timestamptz;
  v_usage integer;
begin
  if p_kind not in ('mcq','interview') then
    return 'invalid_kind';
  end if;

  if exists (select 1 from public.fpsc_daily_sets where set_date = p_target_date and kind = p_kind) then
    return 'cached';
  end if;

  insert into public.fpsc_daily_jobs(set_date, kind, status, started_at, updated_at)
  values (p_target_date, p_kind, 'generating', now(), now())
  on conflict (set_date, kind) do nothing
  returning set_date into v_inserted;

  if v_inserted is null then
    select status, started_at into v_status, v_started
      from public.fpsc_daily_jobs
      where set_date = p_target_date and kind = p_kind
      for update;

    if v_status = 'generating' and v_started > now() - interval '10 minutes' then
      return 'busy';
    end if;

    -- Recover an old crashed generation or permit a retry after a failed provider call.
    update public.fpsc_daily_jobs
      set status = 'generating', started_at = now(), updated_at = now()
      where set_date = p_target_date and kind = p_kind;
  end if;

  insert into public.fpsc_daily_usage(usage_date, generations_used)
  values ((now() at time zone 'utc')::date, 0)
  on conflict (usage_date) do nothing;

  update public.fpsc_daily_usage
    set generations_used = generations_used + 1, updated_at = now()
    where usage_date = (now() at time zone 'utc')::date and generations_used < 2
    returning generations_used into v_usage;

  if v_usage is null then
    update public.fpsc_daily_jobs
      set status = 'blocked', updated_at = now()
      where set_date = p_target_date and kind = p_kind;
    return 'limit_reached';
  end if;

  return 'claimed';
end;
$$;

revoke all on function public.fpsc_claim_generation(date, text) from public, anon, authenticated;
grant execute on function public.fpsc_claim_generation(date, text) to service_role;
