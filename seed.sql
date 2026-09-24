BEGIN;

CREATE TABLE IF NOT EXISTS public.customers (
    id integer PRIMARY KEY,
    full_name text NOT NULL,
    email text NOT NULL,
    country_code text NOT NULL,
    status text NOT NULL,
    created_at timestamptz NOT NULL
);

INSERT INTO public.customers (id, full_name, email, country_code, status, created_at)
SELECT
    id,
    'Customer ' || id,
    'customer' || id || '@example.test',
    (ARRAY['GE', 'US', 'DE', 'GB', 'FR'])[1 + (id - 1) % 5],
    CASE WHEN id % 2 = 1 THEN 'active' ELSE 'inactive' END,
    TIMESTAMPTZ '2025-01-01 00:00:00+00' + id * INTERVAL '1 minute'
FROM generate_series(1, 10000) AS sample(id)
ON CONFLICT (id) DO NOTHING;

COMMIT;

SELECT count(*) AS customer_count FROM public.customers;
SELECT * FROM public.customers ORDER BY id LIMIT 5;
