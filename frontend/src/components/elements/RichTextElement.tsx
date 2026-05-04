import { useEffect, type CSSProperties } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useDocument } from '../../providers/DocumentProvider';
import type { NoteElement } from '../../types';

export function RichTextElement({
  element,
  selected,
  editing,
}: {
  element: NoteElement;
  selected: boolean;
  editing: boolean;
}) {
  const { updateElement, stopEditing } = useDocument();
  const editor = useEditor(
    {
      extensions: [StarterKit.configure({ undoRedo: false })],
      content: element.content || '<p></p>',
      editable: editing,
      editorProps: {
        attributes: {
          class: 'h-full w-full',
        },
      },
      onUpdate: ({ editor: nextEditor }) => {
        updateElement(element.id, { content: nextEditor.getHTML() });
      },
      onBlur: () => {
        stopEditing();
      },
    },
    [element.id],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    editor.setEditable(editing);
    if (editing) {
      window.setTimeout(() => editor.commands.focus('end'), 0);
    }
  }, [editor, editing]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || editor.isFocused) {
      return;
    }
    const html = element.content || '<p></p>';
    if (editor.getHTML() !== html) {
      editor.commands.setContent(html, { emitUpdate: false });
    }
  }, [editor, element.content]);

  const background = String(element.style?.background ?? '');
  const borderWidth = Number(element.style?.borderWidth ?? 0);
  const borderStyle = String(element.style?.borderStyle ?? (borderWidth > 0 ? 'solid' : 'none'));
  const fontFamily = String(element.style?.fontFamily || 'Inter, "Segoe UI", sans-serif');
  const fontSize = Number(element.style?.fontSize ?? 22);
  const color = String(element.style?.color ?? '#2f2a24');
  const textStyle = {
    color,
    fontSize,
    fontFamily,
    '--timenotes-text-font-family': fontFamily,
  } as CSSProperties;

  return (
    <div
      className={`timenotes-rich-text h-full w-full overflow-hidden px-4 py-3 ${
        editing ? 'pointer-events-auto select-text' : 'pointer-events-none'
      } ${selected && editing ? 'shadow-sm' : ''}`}
      style={{
        color,
        background: background || 'transparent',
        boxSizing: 'border-box',
        borderStyle: borderStyle === 'none' ? 'solid' : borderStyle,
        borderWidth: borderStyle === 'none' ? 0 : borderWidth,
        borderColor: String(element.style?.borderColor ?? '#2f2a24'),
        borderRadius: Number(element.style?.borderRadius ?? 0),
        fontSize,
        fontFamily,
        '--timenotes-text-font-family': fontFamily,
        lineHeight: 1.38,
      } as CSSProperties}
    >
      <EditorContent editor={editor} style={textStyle} />
    </div>
  );
}
