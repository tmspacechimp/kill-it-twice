const baseUrl = process.env.DASHBOARDS_URL ?? 'http://dashboards:5601';
const patternUrl = new URL('/api/saved_objects/index-pattern/shipments', baseUrl);
const columns = ['shipment_id', 'version', 'status', 'id', 'occurred_at'];

async function setupDiscover() {
  await ensureShipmentPattern();
  await setDefaultColumns();
}

async function ensureShipmentPattern() {
  const response = await fetch(patternUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'osd-xsrf': 'setup' },
    body: JSON.stringify({ attributes: { title: 'shipments' } }),
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 409) {
    await checkExistingPattern();
    console.log('Shipment index pattern already exists');
    return;
  }

  if (!response.ok) {
    throw new Error(`Creating shipment index pattern failed: ${response.status} ${await response.text()}`);
  }

  console.log('Created shipment index pattern without a time filter');
}

async function checkExistingPattern() {
  const response = await fetch(patternUrl, { signal: AbortSignal.timeout(10_000) });

  if (!response.ok) {
    throw new Error(`Reading shipment index pattern failed: ${response.status}`);
  }

  const { attributes } = await response.json();

  if (attributes.title !== 'shipments' || attributes.timeFieldName) {
    throw new Error('Existing pattern ID "shipments" must target shipments without a time filter');
  }
}

async function setDefaultColumns() {
  const settingsUrl = new URL('/api/opensearch-dashboards/settings', baseUrl);
  const response = await fetch(settingsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'osd-xsrf': 'setup' },
    body: JSON.stringify({ changes: { defaultColumns: columns } }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Setting Discover columns failed: ${response.status} ${await response.text()}`);
  }

  console.log(`Default Discover columns: ${columns.join(', ')}`);
}

setupDiscover().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
