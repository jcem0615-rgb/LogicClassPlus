'use client';

/**
 * Tiptap on a shared Yjs document.
 *
 * Yjs owns the undo history: a shared stack would let one participant undo the
 * other's typing, and per-person undo is what people expect.
 */
import { useEffect, useMemo, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { SocketProvider } from '@/lib/collab';
import { Button } from '@/components/ui';
import type { User } from '@/lib/types';

export function SharedDoc({ sessionId, me, other, isTeacher, legacyHtml }: {
  sessionId: string;
  me: User;
  other: User;
  isTeacher: boolean;
  legacyHtml?: string;
}) {
  // Teacher pine, student rust — the two suite colours, never the same.
  const color = isTeacher ? '#0B6B62' : '#A8452B';
  const [peers, setPeers] = useState<Array<{ name: string; color: string }>>([]);
  const [words, setWords] = useState(0);

  const provider = useMemo(
    () => new SocketProvider(sessionId, { id: me.id, name: me.name, color }),
    [sessionId, me.id, me.name, color]);

  useEffect(() => () => provider.destroy(), [provider]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: provider.doc }),
      CollaborationCursor.configure({ provider, user: { name: me.name, color } }),
    ],
    editorProps: { attributes: { class: 'focus:outline-none', id: 'doc-editor' } },
    onUpdate: ({ editor: e }) => setWords(e.getText().trim().split(/\s+/).filter(Boolean).length),
  }, [provider]);

  /* A document written before live editing existed is HTML, not a CRDT state.
     Seed it once, from the teacher only, so it cannot be inserted twice. */
  useEffect(() => {
    if (!editor || !legacyHtml || !isTeacher) return undefined;
    const timer = setTimeout(() => {
      if (editor.isEmpty) editor.commands.setContent(legacyHtml, false);
    }, 900);
    return () => clearTimeout(timer);
  }, [editor, legacyHtml, isTeacher]);

  useEffect(() => {
    const update = () => {
      const states: Array<{ name: string; color: string }> = [];
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.doc.clientID) return;
        const user = (state as { user?: { name: string; color: string } }).user;
        if (user) states.push(user);
      });
      setPeers(states);
    };
    provider.awareness.on('change', update);
    update();
    return () => provider.awareness.off('change', update);
  }, [provider]);

  const chip = (label: string, tone: string) => (
    <span key={label} className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-[11px]"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
      <i className="h-1.5 w-1.5 rounded-full bg-current" />{label}
    </span>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2" id="doc-presence">
          {chip('You', color)}
          {peers.length
            ? peers.map((p) => chip(`${p.name} · editing`, p.color))
            : <span className="text-[13px] text-ink-3">waiting for {other.name.split(' ')[0]}</span>}
        </div>
        <span className="font-mono text-[13px] text-ink-3">{words} word{words === 1 ? '' : 's'}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 rounded-t-sm border border-b-0 border-line bg-card-2 p-2">
        <Button size="sm" onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></Button>
        <Button size="sm" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></Button>
        <span className="mx-1 h-5 w-px bg-line-2" />
        <Button size="sm" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>Heading</Button>
        <Button size="sm" onClick={() => editor?.chain().focus().toggleBulletList().run()}>List</Button>
        <Button size="sm" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>Numbered</Button>
        <span className="mx-1 h-5 w-px bg-line-2" />
        <Button size="sm" onClick={() => editor?.chain().focus().toggleStrike().run()}>Mark a correction</Button>
        <span className="mx-1 h-5 w-px bg-line-2" />
        <Button size="sm" onClick={() => editor?.chain().focus().undo().run()}>Undo</Button>
        <Button size="sm" onClick={() => editor?.chain().focus().redo().run()}>Redo</Button>
      </div>

      <div className="min-h-[280px] rounded-b-sm border border-line bg-card">
        <EditorContent editor={editor} />
      </div>

      <p className="text-[13px] text-ink-3">
        Live co-editing: every keystroke is a Yjs update merged by the server, which keeps the
        document and writes it to PostgreSQL. Edit from both sides at once — there is nothing to
        overwrite, and undo is per person.
      </p>
    </div>
  );
}
