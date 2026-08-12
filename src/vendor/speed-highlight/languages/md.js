import { detectLanguage } from '../detect.js'

// Markdown authors commonly use language names and filename extensions rather
// than speed-highlight's short internal ids in fenced-code info strings.
const fenceAliases = new Map([
	['c++', 'c'],
	['cpp', 'c'],
	['cxx', 'c'],
	['dockerfile', 'docker'],
	['golang', 'go'],
	['javascript', 'js'],
	['jsx', 'js'],
	['makefile', 'make'],
	['markdown', 'md'],
	['perl', 'pl'],
	['plaintext', 'plain'],
	['python', 'py'],
	['ruby', 'rb'],
	['rust', 'rs'],
	['shell', 'bash'],
	['shellscript', 'bash'],
	['sh', 'bash'],
	['text', 'plain'],
	['tsx', 'ts'],
	['typescript', 'ts'],
	['yml', 'yaml'],
	['zsh', 'bash']
])

const fenceLanguage = code => {
	const info = /^`{3,}[ \t]*([^\s`]+)/.exec(code)?.[1]?.toLowerCase()
	return info ? fenceAliases.get(info) || info : detectLanguage(code)
}

export default [
	{
		type: 'section',
		match: /^[ \t]{0,3}#{1,6}(?:[ \t]+.*)?$/gm
	},
	{
		type: 'cmnt',
		match: /^>.*|(=|-)\1+/gm
	},
	{
		type: 'class',
		match: /\*\*.*?\*\*/g
	},
	{
		match: /^(`{3,})(.*)\n[^]*?^\1[ \t]*$/gm,
		sub: code => ({
			type: 'kwd',
			sub: [
				{
					match: /\n[^]*(?=```)/g,
					sub: fenceLanguage(code)
				}
			]
		})
	},
	{
		type: 'str',
		match: /`[^`]*`/g
	},
	{
		type: 'var',
		match: /~~.*?~~/g
	},
	{
		type: 'kwd',
		match: /\b_\S([^\n]*?\S)?_\b|\*\S([^\n]*?\S)?\*/g
	},
	{
		type: 'kwd',
		match: /^\s*(\*|\d+\.)\s/gm
	},
	{
		type: 'func',
		match: /\[[^\]]*]\([^)]*\)|<[^>]*>/g,
		sub: [
			{
				type: 'oper',
				match: /^\[[^\]]*]/g
			}
		]
	}
]
