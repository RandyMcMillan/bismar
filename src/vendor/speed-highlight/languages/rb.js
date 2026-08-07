export default [
  {
    match: /=begin(?:\r?\n|$)[^]*?^=end.*$/gm,
    sub: 'todo',
  },
  {
    match: /#.*$/gm,
    sub: 'todo',
  },
  {
    type: 'str',
    match: /("(\\[^]|[^"\\])*"?|'(\\[^]|[^'\\])*'?|%[qQwWiIxr]([({[<]).*?[)\]}>])/g,
  },
  {
    type: 'var',
    match: /@@?[a-z_]\w*|\$[a-z_]\w*|:[a-z_]\w*[!?=]?/gi,
  },
  {
    type: 'kwd',
    match:
      /\b(BEGIN|END|alias|and|begin|break|case|class|def|defined\?|do|else|elsif|end|ensure|for|if|in|module|next|not|or|redo|rescue|retry|return|super|then|undef|unless|until|when|while|yield|__FILE__|__LINE__|__ENCODING__)\b/g,
  },
  {
    type: 'bool',
    match: /\b(false|nil|true)\b/g,
  },
  {
    expand: 'num',
  },
  {
    type: 'class',
    match: /\b[A-Z]\w*(?:::[A-Z]\w*)*\b/g,
  },
  {
    type: 'func',
    match: /(?<=\bdef\s)(?:self\.)?[a-z_]\w*[!?=]?|\b[a-z_]\w*[!?]?(?=\s*\()/gi,
  },
  {
    type: 'oper',
    match: /===?|<=>|=~|!~|=>|::|&&|\|\||\*\*|<<|>>|&\.|[-+*/%&|^~<>!]=?|[?:.=]/g,
  },
];
