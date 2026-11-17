-- ============================================================
--  قاعدة بيانات النظام على Supabase (بديل Firestore)
--  كل "مستند" سطر بجدول واحد: col (مسار المجموعة) + id + data (JSON)
--  الكتابة كلها عن طريق الدالة doc_write (عشان العمليات الذرية: زيادة عداد، وقت السيرفر، ...)
--  شغّل هالملف مرة وحدة: Supabase ← SQL Editor ← الصق ← Run
--  بعدها حط إيميل الأدمن تحت (آخر سطر)
-- ============================================================

create table if not exists public.docs (
  col text not null,          -- مثال: 'registrations' أو 'wa_posts/abc/results'
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (col, id)
);
create index if not exists docs_col_updated on public.docs (col, updated_at desc);
create index if not exists docs_data_gin on public.docs using gin (data jsonb_path_ops);
-- عشان التحديث المباشر يوصل بيانات السطر كاملة (حتى عند الحذف)
alter table public.docs replica identity full;

-- إيميلات الأدمن (اللوحة)
create table if not exists public.app_admins (email text primary key);
alter table public.app_admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.role() = 'service_role', false)
      or exists (select 1 from public.app_admins a where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;

-- ---------- أدوات JSON ----------
create or replace function public._ts_now() returns jsonb
language sql volatile as $$ select jsonb_build_object('__ts', floor(extract(epoch from clock_timestamp()) * 1000)::bigint) $$;

-- بيبدّل {"__op":"now"} بأي مكان بوقت السيرفر (للقيم الجديدة اللي ما فيها عمليات تانية)
create or replace function public._resolve(v jsonb) returns jsonb
language plpgsql volatile as $$
declare out jsonb; k text; x jsonb;
begin
  if v is null then return null; end if;
  if jsonb_typeof(v) = 'object' then
    if v ? '__op' then
      if v ->> '__op' = 'now' then return public._ts_now(); end if;
      if v ->> '__op' = 'inc' then return v -> 'n'; end if;
      if v ->> '__op' = 'union' then return coalesce(v -> 'v', '[]'::jsonb); end if;
      if v ->> '__op' = 'remove' then return '[]'::jsonb; end if;
      return null;
    end if;
    out := '{}'::jsonb;
    for k, x in select * from jsonb_each(v) loop
      if jsonb_typeof(x) = 'object' and x ->> '__op' = 'del' then continue; end if;
      out := out || jsonb_build_object(k, public._resolve(x));
    end loop;
    return out;
  elsif jsonb_typeof(v) = 'array' then
    select coalesce(jsonb_agg(public._resolve(e)), '[]'::jsonb) into out from jsonb_array_elements(v) e;
    return out;
  end if;
  return v;
end $$;

-- بيحط قيمة بمسار (وبيعمل الكائنات الوسطية لو ناقصة)
create or replace function public._set_path(base jsonb, path text[], v jsonb) returns jsonb
language plpgsql immutable as $$
declare head text := path[1]; cur jsonb;
begin
  if base is null or jsonb_typeof(base) <> 'object' then base := '{}'::jsonb; end if;
  if array_length(path, 1) = 1 then return base || jsonb_build_object(head, v); end if;
  cur := base -> head;
  return base || jsonb_build_object(head, public._set_path(cur, path[2:], v));
end $$;

-- تطبيق تعديل على مستند: dotted = المفاتيح فيها نقاط مسارات (update)، deep = دمج الكائنات (set مع merge)
create or replace function public._apply(base jsonb, patch jsonb, dotted boolean, deep boolean) returns jsonb
language plpgsql volatile as $$
declare k text; v jsonb; path text[]; cur jsonb; nv jsonb; op text; arr jsonb;
begin
  base := coalesce(base, '{}'::jsonb);
  for k, v in select * from jsonb_each(coalesce(patch, '{}'::jsonb)) loop
    path := case when dotted then string_to_array(k, '.') else array[k] end;
    cur := base #> path;
    if jsonb_typeof(v) = 'object' and v ? '__op' then
      op := v ->> '__op';
      if op = 'del' then base := base #- path; continue;
      elsif op = 'now' then nv := public._ts_now();
      elsif op = 'inc' then
        nv := to_jsonb(coalesce(case when jsonb_typeof(cur) = 'number' then (cur #>> '{}')::numeric end, 0) + (v ->> 'n')::numeric);
      elsif op = 'union' then
        arr := case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end;
        select arr || coalesce(jsonb_agg(e), '[]'::jsonb) into nv
          from (select distinct e from jsonb_array_elements(coalesce(v -> 'v', '[]'::jsonb)) e where not arr @> jsonb_build_array(e)) q;
      elsif op = 'remove' then
        select coalesce(jsonb_agg(e), '[]'::jsonb) into nv
          from jsonb_array_elements(case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end) e
          where not coalesce(v -> 'v', '[]'::jsonb) @> jsonb_build_array(e);
      else continue;
      end if;
    elsif deep and jsonb_typeof(v) = 'object' and not v ? '__ts' then
      nv := public._apply(case when jsonb_typeof(cur) = 'object' then cur else '{}'::jsonb end, v, false, true);
    else
      nv := public._resolve(v);
    end if;
    base := public._set_path(base, path, nv);
  end loop;
  return base;
end $$;

-- ---------- صلاحيات الزوار (بدون تسجيل دخول) ----------
-- نفس قواعد Firestore القديمة: تسجيل جديد، عدّاد الضغطات، طلب من المتجر، تقييم
create or replace function public._public_can(t text, c text, d jsonb) returns boolean
language sql immutable as $$
  select case
    when t = 'create' and c in ('registrations', 'orders', 'order_track', 'reviews') then true
    when t = 'merge' and c = 'track_clicks' then (select bool_and(k in ('pk', 'gk', 'n', 'at')) from jsonb_object_keys(d) k)
    else false
  end
$$;

-- ---------- الكتابة ----------
-- p = {"ops":[{"t":"set|merge|update|create|delete","col":"..","id":"..","data":{..},
--               "expect": {"exists":true|false, "updated_at":".."} (اختياري — للمعاملات)}]}
-- كل العمليات بمعاملة وحدة (يا كلها يا ولا وحدة)
create or replace function public.doc_write(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare o jsonb; t text; c text; i text; d jsonb; old public.docs%rowtype; found_old boolean; admin boolean := public.is_admin(); res jsonb := '[]'::jsonb; nd jsonb;
begin
  for o in select * from jsonb_array_elements(coalesce(p -> 'ops', '[]'::jsonb)) loop
    t := o ->> 't'; c := o ->> 'col'; i := o ->> 'id'; d := coalesce(o -> 'data', '{}'::jsonb);
    if c is null or i is null or c = '' or i = '' then raise exception 'invalid-argument'; end if;
    -- الزائر: "set" = إنشاء بس (ما بيقدر يكتب فوق مستند موجود — نفس قواعد Firestore القديمة)
    if not admin and t = 'set' then t := 'create'; end if;
    if not admin and not public._public_can(t, c, d) then raise exception 'permission-denied'; end if;

    select * into old from public.docs where col = c and id = i for update;
    found_old := found;

    if o ? 'expect' then
      if (o -> 'expect' ->> 'exists')::boolean is distinct from found_old
         or (found_old and o -> 'expect' ? 'updated_at' and old.updated_at <> (o -> 'expect' ->> 'updated_at')::timestamptz) then
        raise exception 'aborted';
      end if;
    end if;

    if t = 'delete' then
      delete from public.docs where col = c and id = i;
      nd := null;
    elsif t = 'create' then
      if found_old then raise exception 'already-exists'; end if;
      nd := public._apply('{}'::jsonb, d, false, false);
      insert into public.docs (col, id, data) values (c, i, nd);
    elsif t = 'set' then
      nd := public._apply('{}'::jsonb, d, false, false);
      insert into public.docs (col, id, data) values (c, i, nd)
        on conflict (col, id) do update set data = excluded.data, updated_at = clock_timestamp();
    elsif t = 'merge' then
      nd := public._apply(case when found_old then old.data else '{}'::jsonb end, d, false, true);
      insert into public.docs (col, id, data) values (c, i, nd)
        on conflict (col, id) do update set data = excluded.data, updated_at = clock_timestamp();
    elsif t = 'update' then
      if not found_old then raise exception 'not-found'; end if;
      nd := public._apply(old.data, d, true, false);
      update public.docs set data = nd, updated_at = clock_timestamp() where col = c and id = i;
    else
      raise exception 'invalid-argument';
    end if;
    -- الزوار ما بيرجعلهم محتوى المستند
    res := res || jsonb_build_array(case when admin then nd else null end);
  end loop;
  return res;
end $$;

-- ---------- القراءة (RLS) ----------
alter table public.docs enable row level security;
drop policy if exists docs_admin_all on public.docs;
create policy docs_admin_all on public.docs for select to authenticated using (public.is_admin());
drop policy if exists docs_public_read on public.docs;
create policy docs_public_read on public.docs for select to anon, authenticated using (
  (col = 'settings' and id = 'site')
  or (col = 'store' and id in ('catalog', 'public'))
  or col = 'order_track'
);
-- الكتابة المباشرة على الجدول ممنوعة (بس عن طريق doc_write)
revoke insert, update, delete on public.docs from anon, authenticated;
grant select on public.docs to anon, authenticated;
grant execute on function public.doc_write(jsonb) to anon, authenticated, service_role;

-- ---------- التحديث المباشر (Realtime) ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.docs;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

-- ---------- إيميل الأدمن ----------
-- غيّر الإيميل لإيميلك (نفس اللي بتسجّل فيه دخول للوحة) وشغّل:
-- insert into public.app_admins (email) values ('your@email.com') on conflict do nothing;
