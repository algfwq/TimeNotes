import Prism from 'prismjs';
import markupLanguage from 'prismjs/components/prism-markup.js?raw';
import cssLanguage from 'prismjs/components/prism-css.js?raw';
import clikeLanguage from 'prismjs/components/prism-clike.js?raw';
import javascriptLanguage from 'prismjs/components/prism-javascript.js?raw';
import jsxLanguage from 'prismjs/components/prism-jsx.js?raw';
import typescriptLanguage from 'prismjs/components/prism-typescript.js?raw';
import tsxLanguage from 'prismjs/components/prism-tsx.js?raw';
import jsonLanguage from 'prismjs/components/prism-json.js?raw';
import goLanguage from 'prismjs/components/prism-go.js?raw';
import bashLanguage from 'prismjs/components/prism-bash.js?raw';
import pythonLanguage from 'prismjs/components/prism-python.js?raw';
import markdownLanguage from 'prismjs/components/prism-markdown.js?raw';
import markupTemplatingLanguage from 'prismjs/components/prism-markup-templating.js?raw';
import cLanguage from 'prismjs/components/prism-c.js?raw';
import cppLanguage from 'prismjs/components/prism-cpp.js?raw';
import csharpLanguage from 'prismjs/components/prism-csharp.js?raw';
import javaLanguage from 'prismjs/components/prism-java.js?raw';
import phpLanguage from 'prismjs/components/prism-php.js?raw';

export type CodeLanguage =
  | 'plaintext'
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'jsx'
  | 'json'
  | 'html'
  | 'css'
  | 'go'
  | 'bash'
  | 'python'
  | 'markdown'
  | 'cpp'
  | 'csharp'
  | 'java'
  | 'php';

export const codeLanguageOptions: Array<{ label: string; value: CodeLanguage }> = [
  { label: 'Plain Text', value: 'plaintext' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'TSX', value: 'tsx' },
  { label: 'JSX', value: 'jsx' },
  { label: 'JSON', value: 'json' },
  { label: 'HTML', value: 'html' },
  { label: 'CSS', value: 'css' },
  { label: 'Go', value: 'go' },
  { label: 'Bash', value: 'bash' },
  { label: 'Python', value: 'python' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'C++', value: 'cpp' },
  { label: 'C#', value: 'csharp' },
  { label: 'Java', value: 'java' },
  { label: 'PHP', value: 'php' },
];

const codeLanguageSet = new Set<CodeLanguage>(codeLanguageOptions.map((option) => option.value));
const prismLanguageSources = [
  markupLanguage,
  cssLanguage,
  clikeLanguage,
  javascriptLanguage,
  jsxLanguage,
  typescriptLanguage,
  tsxLanguage,
  jsonLanguage,
  goLanguage,
  bashLanguage,
  pythonLanguage,
  markdownLanguage,
  // markup-templating 依赖 markup（已加载），必须在 php 之前注册。
  markupTemplatingLanguage,
  // cpp 依赖 c，c 依赖 clike（已加载），顺序：c → cpp。
  cLanguage,
  cppLanguage,
  csharpLanguage,
  javaLanguage,
  phpLanguage,
];

Prism.manual = true;
prismLanguageSources.forEach(registerPrismLanguage);

const languageAliases: Record<string, CodeLanguage> = {
  '': 'plaintext',
  text: 'plaintext',
  plain: 'plaintext',
  js: 'javascript',
  javascriptreact: 'jsx',
  ts: 'typescript',
  typescriptreact: 'tsx',
  html: 'html',
  markup: 'html',
  xml: 'html',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  md: 'markdown',
  golang: 'go',
  cpp: 'cpp',
  'c++': 'cpp',
  'c#': 'csharp',
  csharp: 'csharp',
  cs: 'csharp',
  java: 'java',
  php: 'php',
};

export function normalizeCodeLanguage(value: unknown): CodeLanguage {
  const raw = String(value ?? '').trim().toLowerCase();
  const aliased = languageAliases[raw] ?? raw;
  return codeLanguageSet.has(aliased as CodeLanguage) ? (aliased as CodeLanguage) : 'plaintext';
}

export function codeLanguageLabel(value: unknown) {
  const language = normalizeCodeLanguage(value);
  return codeLanguageOptions.find((option) => option.value === language)?.label ?? 'Plain Text';
}

export function highlightCode(code: string, value: unknown) {
  const language = normalizeCodeLanguage(value);
  if (language === 'plaintext') {
    return escapeHtml(code);
  }
  const prismLanguage = language === 'html' ? 'markup' : language;
  const grammar = Prism.languages[prismLanguage];
  return grammar ? Prism.highlight(code, grammar, prismLanguage) : escapeHtml(code);
}

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function registerPrismLanguage(source: string) {
  // Prism language components are published as small IIFEs that expect a Prism variable in scope.
  Function('Prism', source)(Prism);
}
