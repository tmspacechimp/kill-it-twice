BEGIN;

CREATE TABLE IF NOT EXISTS public.shipment_status_events (
    id integer PRIMARY KEY,
    shipment_id integer NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    status text NOT NULL CHECK (status IN ('created', 'in_transit', 'delivered', 'cancelled')),
    occurred_at timestamptz NOT NULL,
    UNIQUE (shipment_id, version)
);

WITH histories AS (
    SELECT shipment_id, version
    FROM generate_series(1, 4000) AS shipments(shipment_id)
    CROSS JOIN LATERAL generate_series(
        1, CASE WHEN shipment_id % 2 = 1 THEN 3 ELSE 2 END
    ) AS versions(version)
), events AS (
    SELECT
        row_number() OVER (ORDER BY shipment_id, version)::integer AS id,
        shipment_id,
        version,
        CASE
            WHEN version = 1 THEN 'created'
            WHEN shipment_id % 2 = 0 THEN 'cancelled'
            WHEN version = 2 THEN 'in_transit'
            ELSE 'delivered'
        END AS status
    FROM histories
)
INSERT INTO public.shipment_status_events (id, shipment_id, version, status, occurred_at)
SELECT
    id,
    shipment_id,
    version,
    status,
    TIMESTAMPTZ '2025-01-01 00:00:00+00' + id * INTERVAL '1 minute'
FROM events
ON CONFLICT (id) DO NOTHING;

COMMIT;

SELECT count(*) AS event_count, count(DISTINCT shipment_id) AS shipment_count
FROM public.shipment_status_events;
SELECT * FROM public.shipment_status_events ORDER BY id LIMIT 10;
