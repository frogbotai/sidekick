const frame = document.createElement('iframe');

frame.src = chrome.runtime.getURL('frame.html');
frame.title = 'Blocker frame';
document.body.append(frame);
