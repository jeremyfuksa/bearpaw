import { chromium } from 'playwright';

async function fetchJson(page, url) {
  return page.evaluate(async (target) => {
    const response = await fetch(target);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${target}`);
    }
    return response.json();
  }, url);
}

async function run() {
  const baseUrl = process.env.SMOKE_BASE_URL || 'http://localhost:5173';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];

  const record = (step, pass, evidence) => {
    results.push({ step, pass, evidence });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${step}: ${evidence}`);
  };

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const scanTab = page.getByRole('button', { name: /^Scan$/ });
    record('load-ui', await scanTab.isVisible().catch(() => false), 'Scan tab is visible');

    const modelLabel = page.getByText('BC125AT').first();
    record(
      'connected-indicator',
      await modelLabel.isVisible().catch(() => false),
      'BC125AT label is visible',
    );

    const holdButton = page.getByRole('button', { name: /^HOLD$/ }).first();
    const holdVisible = await holdButton.isVisible().catch(() => false);
    if (!holdVisible) {
      record('hold-command', false, 'HOLD button not found');
      record('scan-command', false, 'Skipped (no HOLD button)');
    } else {
      await holdButton.click();
      await page.waitForTimeout(1000);
      const holdStatus = await fetchJson(page, '/api/v1/status');
      record('hold-command', holdStatus.mode === 'HOLD', `mode=${holdStatus.mode}`);

      await holdButton.click();
      await page.waitForTimeout(1000);
      const scanStatus = await fetchJson(page, '/api/v1/status');
      record('scan-command', scanStatus.mode === 'SCAN', `mode=${scanStatus.mode}`);
    }

    const channels = await fetchJson(page, '/api/v1/memory/channels');
    const memoryCount = Array.isArray(channels) ? channels.length : -1;
    record('memory-data', memoryCount > 0, `memory_channels=${memoryCount}`);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`OVERALL FAIL (${failed.length} steps failed)`);
    process.exit(1);
  }
  console.log('OVERALL PASS');
}

run().catch((error) => {
  console.error(`FAIL smoke-e2e: ${error.message}`);
  process.exit(1);
});
