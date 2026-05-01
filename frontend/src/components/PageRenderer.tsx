import type { NoteElement, NotePage } from '../types';
import { ElementRenderer } from './elements/ElementRenderer';

export function PageRenderer({
  page,
  elements,
  onElementContextMenu,
}: {
  page: NotePage;
  elements: NoteElement[];
  onElementContextMenu?: (event: React.MouseEvent, element: NoteElement) => void;
}) {
  return (
    <div className="absolute inset-0" style={{ width: page.width, height: page.height }}>
      {elements
        .slice()
        .sort((first, second) => first.zIndex - second.zIndex)
        .map((element) => (
          <ElementRenderer key={element.id} element={element} onContextMenu={onElementContextMenu} />
        ))}
    </div>
  );
}
