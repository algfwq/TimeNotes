import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: true,
});

markdown.disable(['code', 'fence', 'image'], true);

const defaultValidateLink = markdown.validateLink.bind(markdown);

markdown.validateLink = (url: string) => defaultValidateLink(url) && isSafeMarkdownLink(url);

export function renderMarkdownToHtml(source: string) {
  const html = markdown.render(source.replace(/\r\n?/g, '\n').trim());
  return stripCodeBlocks(html).trim();
}

export function looksLikeMarkdown(source: string) {
  const text = source.trim();
  if (!text) {
    return false;
  }
  return markdownSyntaxPatterns.some((pattern) => pattern.test(text));
}

function stripCodeBlocks(html: string) {
  return html.replace(/<pre[\s\S]*?<\/pre>/gi, '');
}

function isSafeMarkdownLink(url: string) {
  const trimmed = url.trim();
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    return true;
  }
  try {
    const parsed = new URL(trimmed, 'https://timenotes.local');
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

const markdownSyntaxPatterns = [
  /(^|\n)#{1,3}\s+\S/,
  /(^|\n)\s*[-*+]\s+\S/,
  /(^|\n)\s*\d+\.\s+\S/,
  /(^|\n)\s*>\s+\S/,
  /(^|\n)\s*(?:-{3,}|\*{3,}|_{3,})\s*(?:\n|$)/,
  /\*\*[^*\n][\s\S]*?\*\*/,
  /(^|[^*])\*[^*\n]+\*(?!\*)/,
  /~~[^~\n]+~~/,
  /`[^`\n]+`/,
  /\[[^\]\n]+\]\([^)]+\)/,
];
