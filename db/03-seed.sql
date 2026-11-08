SELECT setseed(0.42);

INSERT INTO categories (name) VALUES
  ('books'),
  ('electronics'),
  ('clothing'),
  ('home'),
  ('sports'),
  ('toys'),
  ('grocery'),
  ('beauty'),
  ('garden'),
  ('automotive'),
  ('music'),
  ('movies'),
  ('games'),
  ('office'),
  ('pets'),
  ('baby'),
  ('jewelry'),
  ('tools'),
  ('health'),
  ('outdoor');

INSERT INTO items (title, price, category_id, created_at)
SELECT
  'seed-item-' || lpad(gs::text, 6, '0'),
  round((random() * 999.99)::numeric, 2),
  1 + floor(random() * 20)::int,
  (
    timestamptz '2025-01-01 00:00:00+00'
    - ((floor(random() * 365)::int || ' days')::interval)
    - ((floor(random() * 86400)::int || ' seconds')::interval)
  )
FROM generate_series(1, 100000) AS gs;
