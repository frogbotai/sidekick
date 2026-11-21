# Ported from browse

`edit.ts` is ported from [anomalyco/browse](https://github.com/anomalyco/browse) at `be5528ff2194c8defab74d41e13abb7cb149548e`, `cli/src/setup/agent-config.ts` (`editAgentConfig`), under the MIT License below.

Changes from the original:

- One entry shape per call (`ConfigEntry`), so the agent table lives in `../agents.ts`.
- JSON and TOML only: none of the agents Sidekick writes to uses YAML yet.
- A JSON insertion keeps the formatting of every other line, and an uninstall restores the original bytes.
- Each install copies the file to `<file>.sidekick-backup` first, and an uninstall puts those bytes back when the file holds only what the install added. A link to a missing file writes the file it names.
- A file that doesn't parse returns `invalid` instead of throwing.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
