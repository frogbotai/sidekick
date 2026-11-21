const TEXT_CAP = 3_000;

const TITLE_CAP = 300;

const SCRIPT_CAP = 50;

function find(selector: string) {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

/** The main frame as wall detection reads it: URL, title, capped text and the vendor elements present. */
export function probePage(selectors: string[]) {
  const text = document.body?.innerText ?? '';
  const matched: string[] = [];
  const visible: string[] = [];

  for (const selector of selectors) {
    const element = find(selector);

    if (!element) continue;

    matched.push(selector);

    const { width, height } = element.getBoundingClientRect();

    if (width > 0 && height > 0) visible.push(selector);
  }

  return {
    url: location.href,
    title: document.title.slice(0, TITLE_CAP),
    text: text.slice(0, TEXT_CAP),
    textLength: text.length,
    scriptSrcs: Array.from(document.scripts, (script) => script.src)
      .filter(Boolean)
      .slice(0, SCRIPT_CAP),
    selectors: matched,
    visibleSelectors: visible,
  };
}
