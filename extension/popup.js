const enabled = document.querySelector('#enabled');

chrome.storage.local.get({ wacSettings: { enabled: true } }, ({ wacSettings }) => {
  enabled.checked = wacSettings.enabled !== false;
});

enabled.addEventListener('change', async () => {
  const { wacSettings = {} } = await chrome.storage.local.get('wacSettings');
  const next = { ...wacSettings, enabled: enabled.checked };
  await chrome.storage.local.set({ wacSettings: next });
  const tabs = await chrome.tabs.query({ url: 'https://wplace.live/*' });
  for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'wac:set-enabled', enabled: enabled.checked }).catch(() => {});
});

document.querySelector('#open').addEventListener('click', () => chrome.tabs.create({ url: 'https://wplace.live/' }));
