import type { NoteDocument, NoteElement, NotePage } from '../types';

const page: NotePage = {
  id: 'page-1',
  title: '第 1 页',
  width: 794,
  height: 1123,
  background: '#fffaf0',
};

const elements: NoteElement[] = [];

export function createSeedDocument(): NoteDocument {
  const now = new Date().toISOString();
  return {
    formatVersion: 3,
    title: 'TimeNotes 手账',
    createdAt: now,
    updatedAt: now,
    pages: [page],
    elements,
    assets: [],
    stickers: [],
    fonts: [],
    templates: [],
  };
}
