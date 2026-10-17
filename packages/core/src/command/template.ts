const ARGS = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi;

const PLACEHOLDER = /\$(\d+)/g;

const QUOTE_TRIM = /^["']|["']$/g;

/** Splits typed input into arguments: quotes group words, and `[Image N]` stays one. */
export function parseArguments(input: string) {
  return (input.match(ARGS) ?? []).map((arg) => arg.replace(QUOTE_TRIM, ''));
}

/**
 * OpenCode v2's template expansion, without shell interpolation: `$1…$N` take arguments and the
 * highest takes the rest, `$ARGUMENTS` is the raw input, and with neither the input is appended
 * after a blank line. Replacement is literal, so `$&` in the input stays `$&`.
 */
export function expandTemplate(template: string, input: string) {
  const args = parseArguments(input);
  const placeholders = template.match(PLACEHOLDER) ?? [];
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))));

  const expanded = template.replaceAll(PLACEHOLDER, (_, index: string) => {
    const position = Number(index);
    const argIndex = position - 1;

    if (argIndex >= args.length) return '';

    if (position === last) return args.slice(argIndex).join(' ');

    return args[argIndex] ?? '';
  });

  const withArguments = expanded.replaceAll('$ARGUMENTS', () => input);

  return placeholders.length === 0 && !template.includes('$ARGUMENTS') && input.trim()
    ? `${withArguments}\n\n${input}`.trim()
    : withArguments.trim();
}
