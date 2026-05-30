import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { Button, ButtonGroup, Input, Modal, TextArea, Tooltip } from '@douyinfe/semi-ui';
import {
  IconBold,
  IconClear,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconItalic,
  IconLink,
  IconList,
  IconMinus,
  IconOrderedList,
  IconQuote,
  IconStrikeThrough,
} from '@douyinfe/semi-icons';
import type { Editor } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { findClosestLinkHref, openExternalLink } from '../../lib/externalLinks';
import { looksLikeMarkdown, renderMarkdownToHtml } from '../../lib/markdown';
import { useDocument } from '../../providers/DocumentProvider';
import type { NoteElement } from '../../types';

const defaultInlineCodeFontFamily = '"Cascadia Code", "Fira Code", Consolas, "SFMono-Regular", monospace';

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
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const dialogOpenRef = useRef(false);
  const [toolbarRevision, setToolbarRevision] = useState(0);
  const [markdownVisible, setMarkdownVisible] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState('');
  const [linkVisible, setLinkVisible] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [linkError, setLinkError] = useState('');
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          heading: { levels: [1, 2, 3] },
          link: {
            openOnClick: false,
            autolink: false,
            linkOnPaste: false,
            HTMLAttributes: {
              rel: 'noopener noreferrer',
              target: '_blank',
            },
          },
          undoRedo: false,
        }),
      ],
      content: element.content || '<p></p>',
      editable: editing,
      editorProps: {
        attributes: {
          class: 'h-full w-full',
        },
        handlePaste(view, event) {
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (!text || !looksLikeMarkdown(text)) {
            return false;
          }
          const html = renderMarkdownToHtml(text);
          if (!html) {
            return false;
          }
          event.preventDefault();
          const wrapper = document.createElement('div');
          wrapper.innerHTML = html;
          const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(wrapper);
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        },
      },
      onUpdate: ({ editor: nextEditor }) => {
        updateElement(element.id, { content: nextEditor.getHTML() });
      },
      onBlur: ({ event }) => {
        if (dialogOpenRef.current) {
          return;
        }
        const relatedTarget = event.relatedTarget;
        if (relatedTarget instanceof Node && toolbarRef.current?.contains(relatedTarget)) {
          return;
        }
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

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const refreshToolbar = () => setToolbarRevision((value) => value + 1);
    editor.on('selectionUpdate', refreshToolbar);
    editor.on('transaction', refreshToolbar);
    return () => {
      editor.off('selectionUpdate', refreshToolbar);
      editor.off('transaction', refreshToolbar);
    };
  }, [editor]);

  const openMarkdownDialog = () => {
    dialogOpenRef.current = true;
    setMarkdownDraft('');
    setMarkdownVisible(true);
  };

  const closeMarkdownDialog = () => {
    dialogOpenRef.current = false;
    setMarkdownVisible(false);
    window.setTimeout(() => editor?.commands.focus(), 0);
  };

  const applyMarkdownImport = () => {
    const html = renderMarkdownToHtml(markdownDraft);
    if (html) {
      editor?.chain().focus().insertContent(html).run();
    }
    closeMarkdownDialog();
  };

  const openLinkDialog = () => {
    dialogOpenRef.current = true;
    setLinkError('');
    setLinkDraft(String(editor?.getAttributes('link').href ?? ''));
    setLinkVisible(true);
  };

  const closeLinkDialog = () => {
    dialogOpenRef.current = false;
    setLinkVisible(false);
    setLinkError('');
    window.setTimeout(() => editor?.commands.focus(), 0);
  };

  const applyLink = () => {
    const href = normalizeEditorLink(linkDraft);
    if (!linkDraft.trim()) {
      editor?.chain().focus().extendMarkRange('link').unsetLink().run();
      closeLinkDialog();
      return;
    }
    if (!href) {
      setLinkError('仅支持 http、https、mailto、tel 或页面内锚点链接');
      return;
    }
    editor?.chain().focus().extendMarkRange('link').setLink({ href }).run();
    closeLinkDialog();
  };

  const handleLinkPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (findClosestLinkHref(event.target)) {
      event.stopPropagation();
    }
  };

  const handleLinkMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (findClosestLinkHref(event.target)) {
      event.stopPropagation();
    }
  };

  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const href = findClosestLinkHref(event.target);
    if (!href) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void openExternalLink(href);
  };

  const stopWheelPropagation = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const background = String(element.style?.background ?? '');
  const borderWidth = Number(element.style?.borderWidth ?? 0);
  const borderStyle = String(element.style?.borderStyle ?? (borderWidth > 0 ? 'solid' : 'none'));
  const fontFamily = String(element.style?.fontFamily || 'Inter, "Segoe UI", sans-serif');
  const fontSize = Number(element.style?.fontSize ?? 22);
  const color = String(element.style?.color ?? '#2f2a24');
  const inlineCodeColor = String(element.style?.inlineCodeColor ?? '#8a3f58');
  const inlineCodeFontFamily = String(element.style?.inlineCodeFontFamily || defaultInlineCodeFontFamily);
  const blockquoteColor = String(element.style?.blockquoteColor ?? '#5f5650');
  const blockquoteFontFamily = String(element.style?.blockquoteFontFamily || fontFamily);
  const textStyle = {
    color,
    fontSize,
    fontFamily,
    '--timenotes-text-font-family': fontFamily,
    '--timenotes-inline-code-color': inlineCodeColor,
    '--timenotes-inline-code-font-family': inlineCodeFontFamily,
    '--timenotes-blockquote-color': blockquoteColor,
    '--timenotes-blockquote-font-family': blockquoteFontFamily,
  } as CSSProperties;

  return (
    <>
      <div
        className={`timenotes-rich-text relative h-full w-full overflow-visible px-4 py-3 ${
        editing ? 'pointer-events-auto select-text' : 'pointer-events-auto'
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
          '--timenotes-inline-code-color': inlineCodeColor,
          '--timenotes-inline-code-font-family': inlineCodeFontFamily,
          '--timenotes-blockquote-color': blockquoteColor,
          '--timenotes-blockquote-font-family': blockquoteFontFamily,
          lineHeight: 1.38,
        } as CSSProperties}
      >
        {editing && editor ? (
          <MarkdownToolbar
            editor={editor}
            revision={toolbarRevision}
            toolbarRef={toolbarRef}
            onImportMarkdown={openMarkdownDialog}
            onEditLink={openLinkDialog}
          />
        ) : null}
        <div
          className="timenotes-text-scroll h-full w-full overflow-auto"
          onPointerDownCapture={handleLinkPointerDown}
          onMouseDownCapture={handleLinkMouseDown}
          onClickCapture={handleLinkClick}
          onWheel={stopWheelPropagation}
        >
          <EditorContent editor={editor} className="h-full w-full" style={textStyle} />
        </div>
      </div>
      <Modal
        title="导入 Markdown"
        visible={markdownVisible}
        onCancel={closeMarkdownDialog}
        onOk={applyMarkdownImport}
        okText="插入"
        cancelText="取消"
        width={560}
      >
        <TextArea
          autosize={{ minRows: 8, maxRows: 14 }}
          placeholder="粘贴 Markdown，支持标题、列表、引用、分隔线、链接、粗体、斜体、删除线和行内代码。"
          value={markdownDraft}
          onChange={setMarkdownDraft}
        />
      </Modal>
      <Modal title="编辑链接" visible={linkVisible} onCancel={closeLinkDialog} onOk={applyLink} okText="应用" cancelText="取消" width={420}>
        <Input
          autoFocus
          placeholder="https://example.com"
          value={linkDraft}
          onChange={(value) => {
            setLinkDraft(value);
            setLinkError('');
          }}
          onEnterPress={applyLink}
        />
        {linkError ? <div className="mt-2 text-xs text-red-600">{linkError}</div> : null}
      </Modal>
    </>
  );
}

function MarkdownToolbar({
  editor,
  revision,
  toolbarRef,
  onImportMarkdown,
  onEditLink,
}: {
  editor: Editor;
  revision: number;
  toolbarRef: RefObject<HTMLDivElement>;
  onImportMarkdown: () => void;
  onEditLink: () => void;
}) {
  void revision;
  return (
    <div
      ref={toolbarRef}
      className="timenotes-markdown-toolbar absolute left-0 top-0 z-50 flex -translate-y-[calc(100%+8px)] flex-wrap items-center gap-1 rounded-[8px] border border-black/10 bg-white/95 p-1 shadow-lg backdrop-blur"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ButtonGroup size="small">
        <ToolbarButton label="一级标题" active={editor.isActive('heading', { level: 1 })} icon={<IconH1 />} onRun={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
        <ToolbarButton label="二级标题" active={editor.isActive('heading', { level: 2 })} icon={<IconH2 />} onRun={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <ToolbarButton label="三级标题" active={editor.isActive('heading', { level: 3 })} icon={<IconH3 />} onRun={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} />
      </ButtonGroup>
      <ButtonGroup size="small">
        <ToolbarButton label="粗体" active={editor.isActive('bold')} icon={<IconBold />} onRun={() => editor.chain().focus().toggleBold().run()} />
        <ToolbarButton label="斜体" active={editor.isActive('italic')} icon={<IconItalic />} onRun={() => editor.chain().focus().toggleItalic().run()} />
        <ToolbarButton label="删除线" active={editor.isActive('strike')} icon={<IconStrikeThrough />} onRun={() => editor.chain().focus().toggleStrike().run()} />
        <ToolbarButton label="行内代码" active={editor.isActive('code')} icon={<IconCode />} onRun={() => editor.chain().focus().toggleCode().run()} />
      </ButtonGroup>
      <ButtonGroup size="small">
        <ToolbarButton label="无序列表" active={editor.isActive('bulletList')} icon={<IconList />} onRun={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolbarButton label="有序列表" active={editor.isActive('orderedList')} icon={<IconOrderedList />} onRun={() => editor.chain().focus().toggleOrderedList().run()} />
        <ToolbarButton label="引用" active={editor.isActive('blockquote')} icon={<IconQuote />} onRun={() => editor.chain().focus().toggleBlockquote().run()} />
        <ToolbarButton label="分隔线" icon={<IconMinus />} onRun={() => editor.chain().focus().setHorizontalRule().run()} />
      </ButtonGroup>
      <ButtonGroup size="small">
        <ToolbarButton label="链接" active={editor.isActive('link')} icon={<IconLink />} onRun={onEditLink} />
        <ToolbarButton label="清除格式" icon={<IconClear />} onRun={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} />
        <ToolbarButton label="导入 Markdown" onRun={onImportMarkdown}>MD</ToolbarButton>
      </ButtonGroup>
    </div>
  );
}

function ToolbarButton({
  label,
  active = false,
  icon,
  children,
  onRun,
}: {
  label: string;
  active?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  onRun: () => void;
}) {
  return (
    <Tooltip content={label}>
      <Button
        aria-label={label}
        tabIndex={-1}
        size="small"
        type={active ? 'primary' : 'tertiary'}
        theme={active ? 'solid' : 'borderless'}
        icon={icon}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onRun();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </Button>
    </Tooltip>
  );
}

function normalizeEditorLink(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    return trimmed;
  }
  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}
