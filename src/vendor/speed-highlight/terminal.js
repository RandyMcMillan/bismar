/**
 * @module terminal
 * (Terminal adaptor)
*/

/**
 * @typedef {import('./index.js').ShjLanguage} ShjLanguage
 */

/**
 * Languages supported
 * @typedef {('default'|'atom-dark')} ShjTerminalTheme
 */

import { tokenize } from './index.js';
import { terminalText } from '../../env.ts';

let theme = import('./themes/default.js');

/**
 * Highlight a string passed as argument and return a string that can directly be printed
 *
 * @async
 * @function highlightText
 * @param {string} src The code
 * @param {ShjLanguage} lang The language of the code
 * @returns {Promise<string>} The highlighted string
 */
export const highlightText = async (src, lang) => {
	let res = '', themeMap = (await theme).default;

	// Token callbacks echo source slices verbatim between bismar-owned SGRs.
	// Make those slices inert first: package source is hostile terminal input,
	// even when its grammar happens to recognize it as a string or comment.
	src = terminalText(src, { multiline: true, tabs: 2 });

	await tokenize(src, lang, (str, token) => res += token ? `${themeMap[token] ?? ''}${str}\x1b[0m` : str);

	return res;
};

// Make every highlighted source line self-contained. Language tokens can span
// newlines (block comments, template strings); diff rows are later interleaved
// from the old and new sides, so an open color must not leak into the next row.
const stableLines = src => {
	let active = ''
	return src.split('\n').map(line => {
		const prefix = active
		for (const match of line.matchAll(/\x1b\[[\d;]+m/g))
			active = match[0] === '\x1b[0m' ? '' : match[0]
		return `${prefix}${line}${active ? '\x1b[0m' : ''}`
	})
}

/**
 * Highlight unified-diff payloads as their source language. Added/deleted
 * markers keep the diff colors while the code after them gets ordinary syntax
 * colors. Old and new hunk sides are tokenized separately so edits do not
 * corrupt each other's language state.
 *
 * Diff/file headers are deliberately returned unchanged; the caller owns their
 * presentation (bold/cyan in bismar).
 *
 * @async
 * @function highlightDiffText
 * @param {string} src The unified diff
 * @param {ShjLanguage} lang The source language inside the diff
 * @returns {Promise<string>}
 */
export const highlightDiffText = async (src, lang) => {
	const lines = terminalText(src, { multiline: true, tabs: 2 }).split('\n'), out = [], themeMap = (await theme).default
	for (let i = 0; i < lines.length;) {
		const line = lines[i]
		if (!/^@@ .* @@/.test(line)) {
			out.push(line)
			i++
			continue
		}
		out.push(line)
		i++
		const rows = []
		while (i < lines.length && /^[ +\-]/.test(lines[i])) rows.push(lines[i++])
		const oldSource = rows.filter(row => row[0] !== '+').map(row => row.slice(1)).join('\n')
		const newSource = rows.filter(row => row[0] !== '-').map(row => row.slice(1)).join('\n')
		const [oldLines, newLines] = await Promise.all([
			highlightText(oldSource, lang).then(stableLines),
			highlightText(newSource, lang).then(stableLines)
		])
		let oldAt = 0, newAt = 0
		for (const row of rows) {
			const mark = row[0]
			const body = mark === '-' ? oldLines[oldAt++] : newLines[newAt++]
			if (mark === ' ') oldAt++
			const token = mark === '-' ? 'deleted' : mark === '+' ? 'insert' : undefined
			out.push(`${token ? `${themeMap[token] ?? ''}${mark}\x1b[0m` : mark}${body ?? ''}`)
		}
	}
	return out.join('\n')
}

/**
 * Highlight and print a given string
 *
 * @async
 * @function printHighlight
 * @param {string} src The code
 * @param {ShjLanguage} lang The language of the code
 */
export const printHighlight = async (src, lang) => console.log(await highlightText(src, lang));

/**
 * Change the current used theme for highlighting
 *
 * @function setTheme
 * @param {ShjTerminalTheme} name The name of the theme
 */
export const setTheme = async name => theme = import(`./themes/${name}.js`);
