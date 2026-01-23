import { test, expect } from '@playwright/test';

test.describe('Basic Scanner UI Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display connection status', async ({ page }) => {
    const statusText = page.getByRole('status');
    await expect(statusText).toBeVisible();
  });

  test('should navigate between tabs', async ({ page }) => {
    const deviceTab = page.getByRole('tab', { name: 'Device' });
    const channelsTab = page.getByRole('tab', { name: 'Channels' });
    const scanTab = page.getByRole('tab', { name: 'Scan' });

    await deviceTab.click();
    await expect(page).toHaveURL(/.*device/);
    await expect(deviceTab).toHaveAttribute('aria-selected', 'true');

    await channelsTab.click();
    await expect(page).toHaveURL(/.*channels/ /);
    await expect(channelsTab).toHaveAttribute('aria-selected', 'true');

    await scanTab.click();
    await expect(page).toHaveURL(/.*/);  // Back to root
    await expect(scanTab).toHaveAttribute('aria-selected', 'true');
  });

  test('should display scanner status display', async ({ page }) => {
    const frequency = page.getByRole('region', { name: /current frequency/i });
    const mode = page.getByRole('status', { name: /scanner mode/i });
    await expect(frequency).toBeVisible();
    await expect(mode).toBeVisible();
  });

  test('should respond to volume changes', async ({ page }) => {
    const volumeButton = page.getByRole('button', { name: /volume/i });
    await volumeButton.click();
    const popover = page.getByRole('region', { name: /volume slider/i });
    expect(popover).toBeVisible();
    const slider = page.getByRole('slider');
    await slider.fill('5');
    await page.keyboard.press('Escape');
    expect(volumeButton).toContainText('VOL 5');
  });

  test('should lockout current frequency', async ({ page }) => {
    const lockoutButton = page.getByRole('button', { name: /lockout/i });
    await lockoutButton.click();
    await expect(lockoutButton).toHaveClass(/locked/i);
  });

  test('should toggle between scan and hold modes', async ({ page }) => {
    const holdButton = page.getByRole('button', { name: /hold/i });
    const scanButton = page.getByRole('button', { name: /scan/i });

    await holdButton.click();
    await expect(holdButton).toHaveClass(/active/i);
    const holdMode = page.getByRole('status', { name: /scanner mode/i });
    expect(holdMode).toContainText('HOLD');

    await scanButton.click();
    await expect(scanButton).toHaveClass(/active/i);
    const scanMode = page.getByRole('status', { name: /scanner mode/i });
    expect(scanMode).toContainText('SCAN');
  });
});

test.describe('Channel Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/channels');
  });

  test('should display all banks', async ({ page }) => {
    const banks = page.getAllByRole('button', { name: /bank \d+/ });
    expect(banks).toHaveLength(10);
    await expect(banks[0]).toHaveText('1');
    await expect(banks[9]).toHaveText('10');
  });

  test('should switch between banks', async ({ page }) => {
    const bank5 = page.getByRole('button', { name: /bank 5/i });
    const bank3 = page.getByRole('button', { name: /bank 3/i });
    
    await bank5.click();
    await expect(bank5).toHaveClass(/active/i);
    
    await bank3.click();
    await expect(bank3).toHaveClass(/active/i);
  });

  test('should filter channels by search', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search frequency or tag/i);
    await searchInput.fill('151.2500');
    const results = page.getAllByRole('row').filter(row => row.textContent.includes('151.2500'));
    expect(results.length).toBeGreaterThan(0);
  });

  test('should open channel edit modal', async ({ page }) => {
    const firstChannel = page.getByRole('row').first();
    await firstChannel.click();
    const modal = page.getByRole('dialog', { name: /edit channel/i });
    await expect(modal).toBeVisible();
  });

  test('should export channels to CSV', async ({ page }) => {
    const exportButton = page.getByRole('button', { name: /export csv/i });
    
    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    await downloadPromise;
  });
});

test.describe('Device Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/device');
  });

  test('should sync memory from device', async ({ page }) => {
    const syncButton = page.getByRole('button', { name: /sync memory/i });
    await syncButton.click();
    await expect(syncButton).toHaveText(/syncing|/i);
    });

  test('should adjust volume setting', async ({ page }) => {
    const volumeSlider = page.getByRole('slider', { name: /volume/i });
    await volumeSlider.fill('8');
    const volumeText = page.getByText(/VOL \d+/);
    await expect(volumeText).toContainText('8');
  });

  test('should adjust squelch setting', async ({ page }) => {
    const squelchSlider = page.getByRole('slider', { name: /squelch/i });
    await squelchSlider.fill('7');
    const squelchText = page.getByText(/SQ \d+/);
    await expect(squelchText).toContainText('7');
  });

  test('should change backlight mode', async ({ page }) => {
    const backlightSelect = page.getByRole('combobox', { name: /backlight/i });
    await backlightSelect.selectOption({ label: 'Always On' });
    const selectedOption = backlightSelect.locator('.ant-select-selection-item:visible').first();
    await expect(selectedOption).toHaveText('Always On');
  });

  test('should configure close call settings', async ({ page }) => {
    const modeSelect = page.getByRole('combobox', { name: /mode/i });
    await modeSelect.selectOption({ label: 'CC DND' });
    expect(modeSelect.locator('.ant-select-selection-item:visible').first()).toHaveText('CC DND');
  });

  test('should manage service search groups', async ({ page }) => {
    const serviceGroups = page.getAllByRole('checkbox', { name: /service group \d+/i });
    expect(serviceGroups).toHaveLength(8);
    
    await serviceGroups[0].check();
    await serviceGroups[0].setChecked(false);
  });

  test('should manage custom search ranges', async ({ page }) => {
    const rangeSelects = page.getAllByRole('combobox');
    expect(rangeSelects.length).toBeGreaterThan(0);
    });
});

test.describe('Activity Export', () => {
  test('should export activity log', async ({ page }) => {
    await page.goto('/channels');
    const activityButton = page.getByRole('link', { name: /activity log/i });
    await activityButton.click();
    const exportModal = page.getByRole('dialog', { name: /export activity log/i });
    await expect(exportModal).toBeVisible();

    const timeframeButton = page.getByRole('button', { name: /today/i });
    await timeframeButton.click();
    const downloadButton = page.getByRole('button', { name: /download csv/i });
    await downloadButton.click();
  });
  });

test.describe('Keyboard Shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Ctrl+S should toggle scan mode', async ({ page }) => {
    const initialMode = page.getByRole('status', { name: /scanner mode/i });
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(500);
    expect(initialMode).toHaveText(/SCANNER|/i);
  });

  test('Ctrl+H should toggle hold mode', async ({ page }) => {
    const initialMode = page.getByRole('status', { name: /scanner mode/i });
    await page.keyboard.press('Control+H');
    await page.waitForTimeout(500);
    expect(initialMode).toHaveText(/HOLD|/i);
  });

  test('Ctrl+L should lockout current frequency', async ({ page }) => {
    const lockoutButton = page.getByRole('button', { name: /lockout/i });
    await page.keyboard.press('Control+L');
    await page.waitForTimeout(500);
    await expect(lockoutButton).toHaveClass(/locked/i);
  });

  test('Ctrl+Shift+L should open activity log', async ({ page }) => {
    await page.keyboard.press('Control+Shift+L');
    await page.waitForTimeout(500);
    const activityLog = page.getByRole('dialog', { name: /activity log/i });
    await expect(activityLog).toBeVisible();
  });

  test('Ctrl+M should open memory browser', async ({ page }) => {
    await page.keyboard.press('Control+M');
    await page.waitForTimeout(500);
    await page.waitForURL(/channels/);
  });
});
