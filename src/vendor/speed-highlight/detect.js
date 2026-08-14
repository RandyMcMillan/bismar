/**
 * @module detect
 * (Language detector)
*/

/**
 * @typedef {import('./index.js').ShjLanguage} ShjLanguage
 */

/** @type {[RegExp, ShjLanguage][]} */
const filenames = [
	[/^(dockerfile|containerfile)$/i, 'docker'],
	[/^(gnu)?makefile$/i, 'make'],
	[/^(gemfile|guardfile|rakefile|vagrantfile)$/i, 'rb'],
	[/\.(asm|s)$/i, 'asm'],
	[/\.(bash|sh|zsh)$/i, 'bash'],
	[/\.bf$/i, 'bf'],
	[/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, 'c'],
	[/\.css$/i, 'css'],
	[/\.csv$/i, 'csv'],
	[/\.diff$|\.patch$/i, 'diff'],
	[/\.dockerfile$/i, 'docker'],
	[/\.go$/i, 'go'],
	[/\.html?$/i, 'html'],
	[/\.http$/i, 'http'],
	[/\.(cfg|conf|ini)$/i, 'ini'],
	[/\.java$/i, 'java'],
	[/\.(cjs|js|jsx|mjs)$/i, 'js'],
	[/\.json$/i, 'json'],
	[/\.log$/i, 'log'],
	[/\.(md|markdown)$/i, 'md'],
	[/\.(mk|make)$/i, 'make'],
	[/\.php$/i, 'php'],
	[/\.(pl|pm)$/i, 'pl'],
	[/\.py$/i, 'py'],
	[/\.rb$/i, 'rb'],
	[/\.rs$/i, 'rs'],
	[/\.sql$/i, 'sql'],
	[/\.toml$/i, 'toml'],
	[/\.(cts|ts|tsx|mts)$/i, 'ts'],
	[/\.(svg|xml)$/i, 'xml'],
	[/\.(yaml|yml)$/i, 'yaml']
]

/**
 * Infer a bundled language from a path. Unlike content detection this is
 * deterministic for short snippets, which is what source previews and diff
 * hunks usually contain.
 *
 * @param {string} filename
 * @returns {ShjLanguage|undefined}
 */
export const languageFromFilename = filename => {
	const base = filename.replaceAll('\\', '/').split('/').pop() || filename
	return filenames.find(([pattern]) => pattern.test(base))?.[1]
}

/**
 * @type {[ShjLanguage, [RegExp, Number]][]}
 */
const languages = [
	['bash', [/#!(\/usr)?\/bin\/bash/g, 500], [/\b(if|elif|then|fi|echo)\b|\$/g, 10]],
	['html', [/<\/?[a-z-]+[^\n>]*>/g, 10], [/^\s+<!DOCTYPE\s+html/g, 500]],
	['http', [/^(GET|HEAD|POST|PUT|DELETE|PATCH|HTTP)\b/g, 500]],
	['js', [/\b(console|await|async|function|export|import|this|class|for|let|const|map|join|require|document|window)\b/g, 10]],
	['ts', [/\b(console|await|async|function|export|import|this|class|for|let|const|map|join|require|document|window|implements|interface|namespace)\b/g, 10]],
	['py', [/\b(def|print|await|async|class|and|or|lambda|import|from|self|asyncio|pass|True|False|None|__init__)\b/g, 10]],
	['rb', [/^#!.*\bruby\b/gm, 500], [/\b(def|end|module|unless|yield)\b|@@?[a-z_]\w*/g, 20]],
	['php', [/<\?(php|=)/gi, 500], [/\$[a-z_]\w*|\b(echo|namespace|trait)\b/gi, 20]],
	['sql', [/\b(SELECT|INSERT|FROM)\b/g, 50]],
	['pl', [/#!(\/usr)?\/bin\/perl/g, 500], [/\b(use|print)\b|\$/g, 10]],
	['lua', [/#!(\/usr)?\/bin\/lua/g, 500]],
	['make', [/\b(ifneq|endif|if|elif|then|fi|echo|.PHONY|^[a-z]+ ?:$)\b|\$/gm, 10]],
	['uri', [/https?:|mailto:|tel:|ftp:/g, 30]],
	['css', [/^(@import|@page|@media|(\.|#)[a-z]+)/gm, 20]],
	['diff', [/^[+><-]/gm, 10], [/^@@ ?[-+,0-9 ]+ ?@@/gm, 25]],
	['md', [/^(>|\t\*|\t\d+.)/gm, 10], [/\[.*\](.*)/g, 10]],
	['docker', [/^(FROM|ENTRYPOINT|RUN)/gm, 500]],
	['xml', [/<\/?[a-z-]+[^\n>]*>/g, 10], [/^<\?xml/g, 500]],
	['c', [/#include\b|\bprintf\s+\(/g, 100]],
	['rs', [/^\s+(use|fn|mut|match)\b/gm, 100]],
	['go', [/\b(func|fmt|package)\b/g, 100]],
	['java', [/^import\s+java/gm, 500]],
	['asm', [/^(section|global main|extern|\t(call|mov|ret))/gm, 100]],
	['css', [/^(@import|@page|@media|(\.|#)[a-z]+)/gm, 20]],
	['json', [/\b(true|false|null|\{})\b|\"[^"]+\":/g, 10]],
	['yaml', [/^(\s+)?[a-z][a-z0-9]*:/gmi, 10]]
]

/**
 * Try to find the language the given code belong to
 *
 * @function detectLanguage
 * @param {string} code The code
 * @returns {ShjLanguage} The language of the code
 */
export const detectLanguage = code => {
	return (languages
		.map(([lang, ...features]) => [
			lang,
			features.reduce((acc, [match, score]) => acc + [...code.matchAll(match)].length * score, 0)
		])
		.filter(([lang, score]) => score > 20)
		.sort((a, b) => b[1] - a[1])[0]?.[0] || 'plain');
}
