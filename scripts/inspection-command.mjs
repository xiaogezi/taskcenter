// Parse one literal command; composition is handled separately below.
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

// A bounded literal batch, not a general shell parser. Reject unsupported syntax.
export function inspectionBatch(command) {
  if (command.length > 65536) return null;
  const heredoc = command.match(/^([^\n]*?)\s*<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\3\s*\n([\s\S]*)$/);
  if (heredoc) {
    const lines = heredoc[5].split("\n");
    const end = lines.findIndex((line) => (heredoc[2] ? line.replace(/^\t+/, "") : line) === heredoc[4]);
    if (end < 0 || lines.slice(end + 1).some((line) => line.trim())) return null;
    const words = inspectionWords(heredoc[1]);
    return words?.length ? [{ words, heredoc: true }] : null;
  }
  const commands = [];
  let start = 0, quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      const words = inspectionWords(command.slice(start, i));
      if (!words?.length || commands.length >= 31) return null;
      commands.push({ words, heredoc: false });
      if (ch === "&") { if (command[i + 1] !== "&") return null; i++; }
      if (ch === "|" && ["|", "&"].includes(command[i + 1])) return null;
      start = i + 1;
    }
  }
  const words = inspectionWords(command.slice(start));
  if (!words?.length) return null;
  return [...commands, { words, heredoc: false }];
}
