const OMITTED = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'meta',
  'link',
  'template',
  'svg',
  'canvas',
]);

const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'details',
  'dialog',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'main',
  'nav',
  'p',
  'section',
  'summary',
]);

const TEXT = 3;

interface Walk {
  base: string;
  pre: boolean;
  list: number;
}

const block = (value: string) => (value.trim() ? `\n\n${value.trim()}\n\n` : '');

const wrap = (value: string, mark: string) => {
  const inner = value.trim();

  return inner
    ? `${value.startsWith(' ') ? ' ' : ''}${mark}${inner}${mark}${value.endsWith(' ') ? ' ' : ''}`
    : value;
};

function absolute(href: string | null, base: string) {
  if (!href) return undefined;

  try {
    const url = new URL(href, base);

    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function children(node: Node, walk: Walk) {
  return [...node.childNodes].map((child) => render(child, walk)).join('');
}

function language(element: Element) {
  const code = element.querySelector('code');
  const classes = `${element.className} ${code?.className ?? ''}`;

  return /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? '';
}

function list(element: Element, walk: Walk, ordered: boolean) {
  const items = [...element.children].filter((child) => child.localName === 'li');
  const start = Number(element.getAttribute('start') ?? '1') || 1;

  const lines = items.map((item, index) => {
    const marker = ordered ? `${start + index}.` : '-';
    const body = children(item, { ...walk, list: walk.list + 1 })
      .trim()
      .replace(/\n{3,}/g, '\n\n')
      .replaceAll('\n', '\n   ');

    return `${marker} ${body}`;
  });

  return walk.list > 0 ? `\n${lines.join('\n')}` : block(lines.join('\n'));
}

function cell(element: Element, walk: Walk) {
  return children(element, walk).replace(/\s+/g, ' ').replaceAll('|', '\\|').trim();
}

function table(element: Element, walk: Walk) {
  const rows = [...element.querySelectorAll('tr')].map((row) =>
    [...row.children]
      .filter((child) => child.localName === 'td' || child.localName === 'th')
      .map((child) => cell(child, walk)),
  );

  const width = Math.max(0, ...rows.map((row) => row.length));

  if (width === 0) return '';

  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;

  const [head = [], ...body] = rows;

  return block(
    [line(head), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...body.map(line)].join(
      '\n',
    ),
  );
}

function element(node: Element, walk: Walk): string {
  const name = node.localName;

  if (OMITTED.has(name)) return '';

  if (/^h[1-6]$/.test(name)) {
    const text = children(node, walk).replace(/\s+/g, ' ').trim();

    return text ? block(`${'#'.repeat(Number(name[1]))} ${text}`) : '';
  }

  switch (name) {
    case 'br':
      return '\n';
    case 'hr':
      return block('---');
    case 'strong':
    case 'b':
      return wrap(children(node, walk), '**');
    case 'em':
    case 'i':
      return wrap(children(node, walk), '_');
    case 'code':
      return walk.pre ? (node.textContent ?? '') : wrap(node.textContent ?? '', '`');
    case 'pre':
      return `\n\n\`\`\`${language(node)}\n${(node.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`;
    case 'a': {
      const text = children(node, walk).replace(/\s+/g, ' ').trim();
      const href = absolute(node.getAttribute('href'), walk.base);

      return text && href ? `[${text}](${href})` : text;
    }

    case 'img': {
      const src = absolute(node.getAttribute('src'), walk.base);

      return src ? `![${node.getAttribute('alt') ?? ''}](${src})` : '';
    }

    case 'ul':
      return list(node, walk, false);
    case 'ol':
      return list(node, walk, true);
    case 'blockquote':
      return block(
        children(node, walk)
          .trim()
          .replace(/\n{3,}/g, '\n\n')
          .split('\n')
          .map((line) => `> ${line}`.trimEnd())
          .join('\n'),
      );
    case 'table':
      return table(node, walk);
    case 'dt':
      return block(wrap(children(node, walk), '**'));
    case 'dd':
      return block(children(node, walk));
    default:
      return BLOCKS.has(name) ? block(children(node, walk)) : children(node, walk);
  }
}

function render(node: Node, walk: Walk): string {
  if (node.nodeType === TEXT) {
    const value = node.textContent ?? '';

    return walk.pre ? value : value.replace(/\s+/g, ' ');
  }

  return node instanceof Element ? element(node, walk) : '';
}

function tidy(markdown: string) {
  return markdown
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/**
 * HTML as markdown, after OpenCode v2's `html-markdown.ts` rules over the panel's `DOMParser`:
 * scripts, styles, frames and embeds dropped; headings, emphasis, code, fenced `pre`, lists,
 * quotes, tables, and links and images made absolute against `base` (http(s) only).
 */
export function htmlToMarkdown(html: string, base: string) {
  const doc = parse(html);

  return tidy(children(doc.body, { base, pre: false, list: 0 }));
}

/** HTML's text, after v2's `extractTextFromHTML`: what the omitted elements hold is skipped. */
export function htmlToText(html: string) {
  const doc = parse(html);

  for (const node of [...doc.body.querySelectorAll([...OMITTED].join(','))]) node.remove();

  return tidy((doc.body.textContent ?? '').replace(/[ \t]+/g, ' '));
}
