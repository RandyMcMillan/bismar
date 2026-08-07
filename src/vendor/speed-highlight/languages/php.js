export default [
  {
    match: /\/\/.*$|#(?!\[).*$|\/\*((?!\*\/)[^])*(\*\/)?/gm,
    sub: 'todo',
  },
  {
    type: 'kwd',
    match: /<\?(php|=)?|\?>/gi,
  },
  {
    type: 'str',
    match: /("(\\[^]|[^"\\])*"?|'(\\[^]|[^'\\])*'?|`(\\[^]|[^`\\])*`?)/g,
  },
  {
    type: 'var',
    match: /\$[a-z_]\w*/gi,
  },
  {
    type: 'kwd',
    match:
      /\b(abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|die|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|enum|eval|exit|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|print|private|protected|public|readonly|require|require_once|return|static|switch|throw|trait|try|unset|use|var|while|xor|yield|yield from)\b/gi,
  },
  {
    type: 'bool',
    match: /\b(false|null|true)\b/gi,
  },
  {
    type: 'type',
    match: /\b(array|bool|callable|float|int|iterable|mixed|never|object|string|void)\b/gi,
  },
  {
    expand: 'num',
  },
  {
    type: 'class',
    match: /\b[A-Z_]\w*(?:\\[A-Z_]\w*)*\b/g,
  },
  {
    type: 'func',
    match: /[a-z_]\w*(?=\s*\()/gi,
  },
  {
    type: 'oper',
    match: /\?->|::|=>|===?|!==?|<=>|\?\?|&&|\|\||\*\*|<<|>>|[-+*/%.&|^~<>!]=?|[?:]/g,
  },
];
