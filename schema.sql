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

-- Medicación / suplementos (checklist diario)
CREATE TABLE IF NOT EXISTS medications (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  notas text,
  -- Free-text tag/time (e.g. "mañana", "8am"). Legacy values manana|mediodia|noche still valid.
  momento text,
  activo boolean NOT NULL DEFAULT true,
  orden int NOT NULL DEFAULT 100,
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS medications_activo_orden_idx ON medications (activo, orden, id);

CREATE TABLE IF NOT EXISTS medication_doses (
  medication_id text NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  fecha date NOT NULL,
  tomado boolean NOT NULL DEFAULT false,
  tomado_en timestamptz,
  actualizado timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (medication_id, fecha)
);
CREATE INDEX IF NOT EXISTS medication_doses_fecha_idx ON medication_doses (fecha DESC);

-- Semilla de ejemplo (nombres genéricos, sin historial médico real)
INSERT INTO medications (id, nombre, notas, momento, activo, orden) VALUES
  ('antibiotico-a', 'Antibiotico A', NULL, 'manana', true, 10),
  ('creatina', 'Creatina', NULL, 'manana', true, 20),
  ('locion-cuero-cabelludo', 'Locion cuero cabelludo', NULL, 'noche', true, 30)
ON CONFLICT (id) DO NOTHING;

-- Lista de compras
CREATE TABLE IF NOT EXISTS shopping_items (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  cantidad text,
  notas text,
  comprado boolean NOT NULL DEFAULT false,
  comprado_en timestamptz,
  orden int NOT NULL DEFAULT 100,
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopping_items_comprado_orden_idx
  ON shopping_items (comprado, orden, id);

-- Semilla de ejemplo (nombres genéricos)
INSERT INTO shopping_items (id, nombre, cantidad, notas, comprado, orden) VALUES
  ('leche', 'Leche', '1 L', NULL, false, 10),
  ('pan', 'Pan', '1', NULL, false, 20),
  ('huevos', 'Huevos', 'docena', NULL, false, 30)
ON CONFLICT (id) DO NOTHING;

-- Gastos (expense tracker)
CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN (
    'mp_wallet', 'mp_card', 'santander_caja', 'santander_visa', 'santander_amex'
  )),
  moneda_default text NOT NULL DEFAULT 'ARS',
  activo boolean NOT NULL DEFAULT true,
  orden int NOT NULL DEFAULT 100,
  creado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  nombre text NOT NULL,
  color text,
  orden int NOT NULL DEFAULT 100,
  activo boolean NOT NULL DEFAULT true,
  creado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS category_rules (
  id text PRIMARY KEY,
  pattern text NOT NULL,
  category_id text REFERENCES categories(id) ON DELETE SET NULL,
  account_id text REFERENCES accounts(id) ON DELETE CASCADE,
  priority int NOT NULL DEFAULT 100,
  -- When true, matching txs are internal/own-account transfers (excluded from spend).
  exclude_expense boolean NOT NULL DEFAULT false,
  activo boolean NOT NULL DEFAULT true,
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS category_rules_priority_idx
  ON category_rules (activo, priority, id);

CREATE TABLE IF NOT EXISTS imports (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  filename text NOT NULL,
  file_hash text NOT NULL,
  source_format text NOT NULL,
  status text NOT NULL CHECK (status IN ('preview', 'confirmed', 'duplicate')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado timestamptz NOT NULL DEFAULT now(),
  confirmado_en timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS imports_file_hash_uidx ON imports (file_hash);
CREATE INDEX IF NOT EXISTS imports_account_creado_idx ON imports (account_id, creado DESC);

CREATE TABLE IF NOT EXISTS transactions (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  import_id text REFERENCES imports(id) ON DELETE SET NULL,
  fingerprint text NOT NULL,
  fecha date NOT NULL,
  descripcion text,
  merchant text,
  tx_type text,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'ARS' CHECK (currency IN ('ARS', 'USD')),
  amount_ars numeric,
  amount_usd numeric,
  category_id text REFERENCES categories(id) ON DELETE SET NULL,
  is_internal_transfer boolean NOT NULL DEFAULT false,
  is_excluded boolean NOT NULL DEFAULT false,
  double_count_guard boolean NOT NULL DEFAULT false,
  notes text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado timestamptz NOT NULL DEFAULT now(),
  actualizado timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS transactions_fecha_idx ON transactions (fecha DESC);
CREATE INDEX IF NOT EXISTS transactions_account_fecha_idx ON transactions (account_id, fecha DESC);
CREATE INDEX IF NOT EXISTS transactions_category_idx ON transactions (category_id);
CREATE INDEX IF NOT EXISTS transactions_excluded_idx ON transactions (is_excluded, fecha DESC);

INSERT INTO accounts (id, nombre, tipo, moneda_default, orden) VALUES
  ('mp_wallet', 'Mercado Pago billetera', 'mp_wallet', 'ARS', 10),
  ('mp_card', 'Mercado Pago tarjeta', 'mp_card', 'ARS', 20),
  ('santander_caja', 'Santander caja', 'santander_caja', 'ARS', 30),
  ('santander_visa', 'Santander Visa', 'santander_visa', 'ARS', 40),
  ('santander_amex', 'Santander Amex', 'santander_amex', 'ARS', 50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO categories (id, nombre, orden) VALUES
  ('comida', 'Comida', 10),
  ('transporte', 'Transporte', 20),
  ('suscripciones', 'Suscripciones', 30),
  ('servicios', 'Servicios', 40),
  ('transferencias', 'Transferencias', 50),
  ('impuestos', 'Impuestos', 60),
  ('ingresos', 'Ingresos', 70),
  ('reintegros', 'Reintegros', 80),
  ('otros', 'Otros', 90)
ON CONFLICT (id) DO NOTHING;

-- Own-account transfer patterns (exclude from spend). Third-party transfers stay categorizable.
INSERT INTO category_rules (id, pattern, category_id, account_id, priority, exclude_expense, activo) VALUES
  ('own-mp-moreno-matias', 'Moreno Matias', 'transferencias', 'mp_wallet', 10, true, true),
  ('own-mp-moreno-upper', 'MORENO MATIAS', 'transferencias', 'mp_wallet', 10, true, true),
  ('guard-amex-merpago', 'Merpago', NULL, 'santander_amex', 5, true, true)
ON CONFLICT (id) DO NOTHING;
