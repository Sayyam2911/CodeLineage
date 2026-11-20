import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import theme from 'shiki/themes/github-dark-default.mjs'

const grammars = {
  bash: () => import('shiki/langs/shellscript.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

const extensions: Record<string, keyof typeof grammars> = {
  bash: 'bash', sh: 'bash', zsh: 'bash', css: 'css', go: 'go', htm: 'html', html: 'html',
  java: 'java', js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'jsonc',
  jsx: 'jsx', md: 'markdown', py: 'python', rs: 'rust', sql: 'sql', toml: 'toml', tsx: 'tsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', yaml: 'yaml', yml: 'yaml',
}

const highlighter = createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() })

export async function highlight(path: string, code: string) {
  const filename = path.split('/').at(-1)?.toLowerCase() ?? ''
  const language = /^\.env(?:\.|$)/.test(filename) ? 'dotenv' : extensions[filename.split('.').at(-1) ?? '']
  if (!language || code.length > 150_000) return []
  const engine = await highlighter
  if (!engine.getLoadedLanguages().includes(language)) await engine.loadLanguage(await grammars[language]())
  return engine.codeToTokens(code, { lang: language, theme: 'github-dark-default' }).tokens
}
