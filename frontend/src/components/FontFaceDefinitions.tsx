import { useMemo } from 'react';
import { fontFamilyForAsset } from '../lib/fonts';
import { useDocument } from '../providers/DocumentProvider';

export function FontFaceDefinitions() {
  const { document } = useDocument();
  // 字体以 data URL 形式从 .tnote 包恢复，阅读和编辑时都不依赖本机是否安装该字体。
  const css = useMemo(
    () =>
      document.fonts
        .filter((font) => font.dataUrl || font.dataBase64)
        .map((font) => {
          const src = font.dataUrl ?? `data:${font.mimeType};base64,${font.dataBase64}`;
          return `@font-face{font-family:"${fontFamilyForAsset(font)}";src:url("${src}") format("${fontFormat(font.mimeType, font.name)}");font-display:swap;}`;
        })
        .join('\n'),
    [document.fonts],
  );

  return css ? <style data-timenotes-fonts>{css}</style> : null;
}

function fontFormat(mimeType: string, name: string) {
  const lower = `${mimeType} ${name}`.toLowerCase();
  if (lower.includes('woff2')) {
    return 'woff2';
  }
  if (lower.includes('woff')) {
    return 'woff';
  }
  if (lower.includes('otf')) {
    return 'opentype';
  }
  return 'truetype';
}
