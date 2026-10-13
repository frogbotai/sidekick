import { registerRichText } from '@lexical/rich-text';
import { ContentState, Editor, EditorState as DraftState } from 'draft-js';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { schema } from 'prosemirror-schema-basic';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

interface BeforeInput {
  editor: string;
  inputType: string;
  data: string | null;
  defaultPrevented: boolean;
}

declare global {
  interface Window {
    editorText: Record<'lexical' | 'prosemirror' | 'draft', () => string>;
    beforeInputs: BeforeInput[];
  }
}

function mount(id: string) {
  const element = document.getElementById(id);

  if (!element) throw new Error(`Missing #${id}`);

  return element;
}

window.beforeInputs = [];

for (const id of ['lexical', 'prosemirror', 'draft']) {
  mount(id).addEventListener('beforeinput', (event) => {
    queueMicrotask(() =>
      window.beforeInputs.push({
        editor: id,
        inputType: event.inputType,
        data: event.data,
        defaultPrevented: event.defaultPrevented,
      }),
    );
  });
}

const lexical = createEditor({
  namespace: 'fixture',
  onError: (error) => {
    throw error;
  },
});

const lexicalRoot = mount('lexical-root');

lexical.setRootElement(lexicalRoot);
registerRichText(lexical);

lexical.update(() => {
  $getRoot().append($createParagraphNode().append($createTextNode('Old lexical text')));
});

const prosemirror = new EditorView(mount('prosemirror'), {
  state: EditorState.create({
    doc: schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Old prosemirror text')]),
    ]),
    plugins: [keymap(baseKeymap)],
  }),
  attributes: { role: 'textbox', 'aria-label': 'ProseMirror editor' },
});

let draftText = 'Old draft text';

function Draft() {
  const [state, setState] = useState(() =>
    DraftState.createWithContent(ContentState.createFromText(draftText)),
  );

  return (
    <Editor
      editorState={state}
      ariaLabel="Draft editor"
      onChange={(next) => {
        draftText = next.getCurrentContent().getPlainText();
        setState(next);
      }}
    />
  );
}

createRoot(mount('draft')).render(<Draft />);

window.editorText = {
  lexical: () => lexical.getEditorState().read(() => $getRoot().getTextContent()),
  prosemirror: () => prosemirror.state.doc.textContent,
  draft: () => draftText,
};
