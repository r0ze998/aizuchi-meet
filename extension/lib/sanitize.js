export function cleanText(s, max = 4000) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}
// Wrap untrusted text as data. Closing tags inside are neutralised.
export function asData(label, text) {
  const body = cleanText(text, 12000).replace(/<\/(\w+)/g, '<\\/$1');
  return `<${label}>\n${body}\n</${label}>`;
}
