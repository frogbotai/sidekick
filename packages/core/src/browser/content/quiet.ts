/** Resolves `true` once the DOM has had no mutations for `quiet` ms, or `false` at `cap`. */
export function domQuiet(quiet: number, cap: number) {
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (settled: boolean) => {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(limit);
      resolve(settled);
    };

    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(true), quiet);
    };

    const observer = new MutationObserver(restart);
    const limit = setTimeout(() => finish(false), cap);

    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    restart();
  });
}
