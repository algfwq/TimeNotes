import { Browser } from '@wailsio/runtime';

const supportedExternalProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function findClosestLinkHref(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return '';
  }
  return target.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href') ?? '';
}

export function normalizeExternalLink(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = new URL(trimmed, window.location.href);
    return supportedExternalProtocols.has(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

export async function openExternalLink(value: string) {
  const href = normalizeExternalLink(value);
  if (!href) {
    return false;
  }
  try {
    await Browser.OpenURL(href);
  } catch {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  return true;
}
