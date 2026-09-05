// Parse one literal shell command. Shell expansion and operators are not L0.
export function inspectionWords(command) {
  const words = [];
  let word = "", quote = "", started = false;
  for (let index = 0; index < command.length; index++) {
    const ch = command[index];
    if (ch === "\n" || ch === "\r") return null;
    if (quote === "'") {
      if (ch === "'") quote = "";
      else word += ch;
      continue;
    }
    if (ch === "$" || ch === "`") return null;
    if (ch === "\\") {
      const next = command[++index];
      if (!next || next === "\n" || next === "\r") return null;
      word += quote === '"' && !['"', "\\", "$", "`"].includes(next) ? `\\${next}` : next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (/[;&<>|(){}*?\[\]~#]/.test(ch)) return null;
    if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = ""; started = false;
    } else { word += ch; started = true; }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}
