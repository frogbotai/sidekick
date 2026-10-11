const button = document.getElementById('open');

if (!(button instanceof HTMLButtonElement)) throw new Error('Missing #open');

const { id: windowId } = await chrome.windows.getCurrent();

if (windowId === undefined) throw new Error('No current window');

button.addEventListener('click', () => {
  void chrome.sidePanel.open({ windowId });
});

button.disabled = false;
