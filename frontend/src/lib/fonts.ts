import type { AssetMeta } from '../types';

export function fontFamilyForAsset(font: AssetMeta) {
  return `TNFont_${font.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function fontDisplayName(font: AssetMeta) {
  return font.name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, '') || font.name;
}
