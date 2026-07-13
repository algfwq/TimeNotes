import { DocumentService } from '../../bindings/changeme';
import type { NotePackage } from '../types';
import { bytesToBase64 } from './base64';
import { logFrontend } from './logger';
import { isMobile } from './platform';

/** 每片原始 JSON UTF-8 字节上限（base64 后约 ×4/3，仍低于 Android Binder ~1MB 限制）。 */
const SAVE_CHUNK_BYTES = 96_000;

/**
 * 保存手账包。
 * - 桌面：原样 DocumentService.SaveNote（行为不变）
 * - 移动端：完整 NotePackage JSON 按 UTF-8 字节分片 → Go 组装写入
 *   （经 ByID 绑定 SaveNoteBegin/Append/Commit，避免单次 IPC 过大）
 */
export async function saveNotePackage(path: string, note: NotePackage): Promise<void> {
  if (!isMobile()) {
    await DocumentService.SaveNote(path, note as any);
    return;
  }

  const json = JSON.stringify(note);
  const bytes = new TextEncoder().encode(json);
  const sessionId = await DocumentService.SaveNoteBegin(path);
  try {
    // 空包也至少提交 1 片（合法 JSON 几乎不会为空，防御 IPC 边界）
    if (bytes.length === 0) {
      await DocumentService.SaveNoteAppend(sessionId, 0, 1, bytesToBase64(new TextEncoder().encode('{}')));
      await DocumentService.SaveNoteCommit(sessionId);
      return;
    }
    const total = Math.ceil(bytes.length / SAVE_CHUNK_BYTES);
    for (let index = 0; index < total; index += 1) {
      const slice = bytes.subarray(index * SAVE_CHUNK_BYTES, (index + 1) * SAVE_CHUNK_BYTES);
      await DocumentService.SaveNoteAppend(sessionId, index, total, bytesToBase64(slice));
    }
    await DocumentService.SaveNoteCommit(sessionId);
  } catch (error) {
    logFrontend('error', 'mobile_save_failed', {
      path,
      bytes: bytes.length,
      sessionId,
      error: String(error),
    });
    throw error;
  }
}
