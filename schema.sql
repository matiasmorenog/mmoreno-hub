CREATE TABLE IF NOT EXISTS brief_meta (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  fecha date NOT NULL,
  titular text,
  corrida text,
  agenda_texto text,
  procesos_texto text,
  fuera_busqueda_texto text,
  descartadas_texto text,
  fuentes_texto text,
  actualizado_en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS items (
  id text PRIMARY KEY,
  seccion text NOT NULL CHECK (seccion IN ('atencion','listos','ofertas','resuelto')),
  titulo text NOT NULL,
  detalle text,
  etiqueta text,
  tono text,
  url text,
  tab_name text,
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  score int,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  prioridad int NOT NULL DEFAULT 100,
  fecha_desde date,
  vence date,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  archivado boolean NOT NULL DEFAULT false,
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_done_at_idx ON items (done_at);
CREATE TABLE IF NOT EXISTS item_log (
  id bigserial PRIMARY KEY,
  item_id text NOT NULL,
  done boolean NOT NULL,
  origen text NOT NULL DEFAULT 'web',
  en timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS applications (
  id serial PRIMARY KEY,
  seccion text NOT NULL,
  fecha date,
  empresa text,
  empresa_key text,
  rol text,
  estado text,
  estado_corto text,
  score int,
  fuente text,
  link text,
  archivo text,
  notas text,
  orden int,
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS applications_empresa_key_idx ON applications (empresa_key);
CREATE INDEX IF NOT EXISTS applications_fecha_idx ON applications (fecha DESC);
CREATE TABLE IF NOT EXISTS seen (
  clave text PRIMARY KEY,
  tipo text NOT NULL,
  empresa_key text,
  fecha date,
  detalle text
);
CREATE TABLE IF NOT EXISTS rutina_estado (
  clave text PRIMARY KEY,
  valor timestamptz NOT NULL DEFAULT now()
);
