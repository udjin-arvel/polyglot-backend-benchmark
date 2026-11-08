CREATE TABLE categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE items (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 255),
  price       NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  category_id INT NOT NULL REFERENCES categories(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX items_category_idx ON items(category_id);
CREATE INDEX items_created_idx  ON items(created_at DESC);
CREATE INDEX items_title_trgm_idx ON items USING gin (title gin_trgm_ops);
