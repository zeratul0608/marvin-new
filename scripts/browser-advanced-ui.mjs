// Follow the same visible path as an embedded editor user, including reopening
// the selected advanced panel after an API call returns to basic properties.
export async function showAdvancedEditor(page, section) {
  const editor = page.locator('chemical-editor').first();
  const toggle = editor.locator('[data-action="toggle-advanced"]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await editor.locator('#advanced-tools').waitFor({ state: 'visible' });
  await editor.locator(`[data-advanced-section="${section}"]`).click();
  if (section !== 'extensions') await editor.locator(`[data-advanced-panel="${section}"]`).waitFor({ state: 'visible' });
}
