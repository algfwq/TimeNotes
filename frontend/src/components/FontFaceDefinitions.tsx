import { useEffect, useMemo } from 'react';
import { fontFamilyForAsset } from '../lib/fonts';
import { useDocument } from '../providers/DocumentProvider';

export function FontFaceDefinitions() {
  const { document: noteDocument } = useDocument();
  const fontSignature = useMemo(
    () =>
      noteDocument.fonts
        .filter((font) => font.dataUrl || font.dataBase64)
        .map((font) => [font.id, font.hash, font.mimeType, font.dataBase64?.length ?? 0, font.dataUrl?.length ?? 0].join(':'))
        .join('|'),
    [noteDocument.fonts],
  );
  const fontFaces = useMemo(
    () =>
      noteDocument.fonts
        .filter((font) => font.dataUrl || font.dataBase64)
        .map((font) => ({
          family: fontFamilyForAsset(font),
          src: font.dataUrl ?? `data:${font.mimeType};base64,${font.dataBase64}`,
        })),
    [fontSignature],
  );
  // 字体以 data URL 形式从 .tnote 包恢复，阅读和编辑时都不依赖本机是否安装该字体。
  const css = useMemo(
    () =>
      fontFaces.map((font) => `@font-face{font-family:"${font.family}";src:url("${font.src}");font-display:swap;}`).join('\n'),
    [fontFaces],
  );

  useEffect(() => {
    const fontSet = globalThis.document?.fonts;
    if (!('FontFace' in window) || !fontSet || fontFaces.length === 0) {
      return;
    }
    const loaded = fontFaces.map((font) => {
      const face = new FontFace(font.family, `url("${font.src}")`, { display: 'swap' });
      fontSet.add(face);
      void face.load().catch(() => undefined);
      return face;
    });
    return () => {
      loaded.forEach((face) => fontSet.delete(face));
    };
  }, [fontFaces]);

  return css ? <style data-timenotes-fonts>{css}</style> : null;
}
