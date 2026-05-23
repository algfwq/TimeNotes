import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { IconCopy } from '@douyinfe/semi-icons';
import { copyTextToClipboard } from '../../lib/clipboard';
import { codeLanguageLabel, highlightCode, normalizeCodeLanguage } from '../../lib/codeHighlighting';
import { useDocument } from '../../providers/DocumentProvider';
import type { NoteDocument, NoteElement } from '../../types';

const codeEditLiveSyncMs = 350;

interface LatestEditorState {
  element: NoteElement;
  updateElement: (id: string, patch: Partial<NoteElement>, options?: { history?: boolean; historyBase?: NoteDocument }) => void;
}

export function CodeBlockElement({
  element,
  selected,
  editing,
}: {
  element: NoteElement;
  selected: boolean;
  editing: boolean;
}) {
  const { document, updateElement, stopEditing } = useDocument();
  const [draft, setDraft] = useState(element.content ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const latestRef = useRef<LatestEditorState>({ element, updateElement });
  const draftRef = useRef(element.content ?? '');
  const historyBaseRef = useRef<NoteDocument | null>(null);
  const editingRef = useRef(false);
  const liveTimerRef = useRef<number | undefined>();
  const pendingLiveContentRef = useRef<string | null>(null);

  useEffect(() => {
    latestRef.current = { element, updateElement };
  }, [element, updateElement]);

  const clearLiveTimer = useCallback(() => {
    if (liveTimerRef.current) {
      window.clearTimeout(liveTimerRef.current);
      liveTimerRef.current = undefined;
    }
  }, []);

  const flushLiveContent = useCallback(() => {
    const nextContent = pendingLiveContentRef.current;
    if (nextContent === null) {
      return;
    }
    pendingLiveContentRef.current = null;
    latestRef.current.updateElement(latestRef.current.element.id, { content: nextContent }, { history: false });
  }, []);

  const finishEditing = useCallback(
    (shouldStopEditing: boolean) => {
      clearLiveTimer();
      pendingLiveContentRef.current = null;
      const historyBase = historyBaseRef.current ?? undefined;
      historyBaseRef.current = null;
      latestRef.current.updateElement(latestRef.current.element.id, { content: draftRef.current }, { historyBase });
      if (shouldStopEditing) {
        stopEditing();
      }
    },
    [clearLiveTimer, stopEditing],
  );

  const queueLiveContent = useCallback(
    (nextContent: string) => {
      pendingLiveContentRef.current = nextContent;
      if (liveTimerRef.current) {
        return;
      }
      liveTimerRef.current = window.setTimeout(() => {
        liveTimerRef.current = undefined;
        flushLiveContent();
      }, codeEditLiveSyncMs);
    },
    [flushLiveContent],
  );

  useEffect(() => {
    if (editing && !editingRef.current) {
      historyBaseRef.current = document;
      const nextContent = element.content ?? '';
      setDraft(nextContent);
      draftRef.current = nextContent;
      const frame = window.requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(nextContent.length, nextContent.length);
      });
      editingRef.current = true;
      return () => window.cancelAnimationFrame(frame);
    }
    if (!editing && editingRef.current) {
      finishEditing(false);
      editingRef.current = false;
    }
    return undefined;
  }, [document, editing, element.content, finishEditing]);

  useEffect(() => {
    if (!editing) {
      const nextContent = element.content ?? '';
      setDraft(nextContent);
      draftRef.current = nextContent;
    }
  }, [editing, element.content]);

  useEffect(() => () => clearLiveTimer(), [clearLiveTimer]);

  const handleChange = (nextContent: string) => {
    setDraft(nextContent);
    draftRef.current = nextContent;
    queueLiveContent(nextContent);
  };

  const style = element.style ?? {};
  const baseStyle = codeBlockStyle(style);
  if (editing) {
    return (
      <div className={`timenotes-code-block timenotes-code-block-editing ${selected ? 'timenotes-code-block-selected' : ''}`} style={baseStyle}>
        <CodeBlockHeader element={element} />
        <textarea
          ref={textareaRef}
          className="timenotes-code-editor timenotes-scrollbar"
          spellCheck={false}
          value={draft}
          onChange={(event) => handleChange(event.target.value)}
          onBlur={() => finishEditing(true)}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              finishEditing(true);
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              finishEditing(true);
              return;
            }
            if (event.key === 'Tab') {
              event.preventDefault();
              const target = event.currentTarget;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              const nextContent = `${draft.slice(0, start)}  ${draft.slice(end)}`;
              handleChange(nextContent);
              window.requestAnimationFrame(() => target.setSelectionRange(start + 2, start + 2));
            }
          }}
        />
      </div>
    );
  }

  return <CodeBlockPreview element={element} selected={selected} />;
}

export function CodeBlockPreview({ element, selected = false, readOnly = false }: { element: NoteElement; selected?: boolean; readOnly?: boolean }) {
  const content = element.content ?? '';
  const language = normalizeCodeLanguage(element.style?.language);
  const highlighted = useMemo(() => highlightCode(content, language), [content, language]);
  return (
    <div
      className={`timenotes-code-block ${selected ? 'timenotes-code-block-selected' : ''} ${readOnly ? 'timenotes-code-block-readonly' : ''}`}
      style={codeBlockStyle(element.style ?? {})}
      onWheel={(event) => event.stopPropagation()}
      onPointerDown={readOnly ? (event) => event.stopPropagation() : undefined}
    >
      <CodeBlockHeader element={element} />
      <pre className="timenotes-code-pre timenotes-scrollbar">
        <code className={`language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

function CodeBlockHeader({ element }: { element: NoteElement }) {
  const languageLabel = codeLanguageLabel(element.style?.language);
  const copyCode = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const copied = await copyTextToClipboard(element.content ?? '');
    if (copied) {
      Toast.success('代码已复制');
    } else {
      Toast.error('复制失败');
    }
  };

  return (
    <div className="timenotes-code-header">
      <span className="timenotes-code-language">{languageLabel}</span>
      <button type="button" className="timenotes-code-copy" title="复制代码" onClick={copyCode} onMouseDown={(event) => event.stopPropagation()}>
        <IconCopy />
      </button>
    </div>
  );
}

function codeBlockStyle(style: Record<string, string | number | boolean>): CSSProperties {
  return {
    color: String(style.color ?? '#d7e2f0'),
    background: String(style.background ?? '#101828'),
    fontSize: Number(style.fontSize ?? 14),
    borderRadius: Number(style.borderRadius ?? 8),
  };
}
