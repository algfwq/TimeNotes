import coffeeCupUrl from '../assets/stickers/ai-coffee-cup.png';
import paperPlaneUrl from '../assets/stickers/ai-paper-plane.png';
import smilingMoonUrl from '../assets/stickers/ai-smiling-moon.png';
import calendarUrl from '../assets/stickers/ai-calendar.png';
import watercolorFlowerUrl from '../assets/stickers/ai-watercolor-flower.png';
import memoHeartUrl from '../assets/stickers/ai-memo-heart.png';

export interface BuiltinSticker {
  id: string;
  name: string;
  url: string;
}

// 内置贴纸来自本项目的 imagegen 生成结果，只作为可选素材库展示；真正使用时会转成 .tnote 内的 stickers 资源。
export const builtinStickers: BuiltinSticker[] = [
  { id: 'builtin-sticker-coffee-cup', name: '咖啡杯贴纸.png', url: coffeeCupUrl },
  { id: 'builtin-sticker-paper-plane', name: '纸飞机贴纸.png', url: paperPlaneUrl },
  { id: 'builtin-sticker-smiling-moon', name: '月亮贴纸.png', url: smilingMoonUrl },
  { id: 'builtin-sticker-calendar', name: '日历贴纸.png', url: calendarUrl },
  { id: 'builtin-sticker-watercolor-flower', name: '花朵贴纸.png', url: watercolorFlowerUrl },
  { id: 'builtin-sticker-memo-heart', name: '便签贴纸.png', url: memoHeartUrl },
];
