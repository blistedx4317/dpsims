-- DPS Amrapali Inventory – database schema (PostgreSQL / Neon)
-- You do NOT have to run this by hand: POST /api/setup creates these tables for you.

create table if not exists users (
  id            serial primary key,
  role          text not null check (role in ('admin','principal','teacher')),
  name          text not null,
  pin_hash      text,
  pw_hash       text,
  must_change   boolean not null default false,
  active        boolean not null default true,
  token_version int not null default 0,
  created_at    timestamptz not null default now(),
  unique (role, name)
);

-- the whole inventory (items, bills, faculty, log, slips, session settings) as one JSON document
create table if not exists app_state (
  key        text primary key,
  data       jsonb not null,
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists login_attempts (
  k     text primary key,
  fails int not null default 0,
  until timestamptz
);

-- assets table: stores images (logos, avatars, stamps), fonts, and stylesheets
create table if not exists assets (
  key          text primary key,
  content_type text not null,
  data         text not null,
  updated_at   timestamptz not null default now()
);
