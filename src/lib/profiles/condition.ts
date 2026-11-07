// OrcaSlicer's `compatible_printers_condition` expressions, the subset vendor profiles use:
//   printer_notes=~/.*PRINTER_VENDOR_PRUSA3D.*/ and printer_model=="MK4" and nozzle_diameter[0]==0.4
// Comparison (== != < > <= >=), regex match (=~ !~), and / or / not, parentheses, numbers, strings, regexes,
// identifiers with an optional [index]. Anything else throws, and the caller treats a failed evaluation as true,
// as OrcaSlicer does.

type Value = string | number | boolean | RegExp;
type Lookup = (name: string, index: number | null) => string | undefined;

interface Token {
  kind: 'num' | 'str' | 're' | 'id' | 'op' | 'lp' | 'rp' | 'lb' | 'rb';
  text: string;
}

function tokenise(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ kind: 'lp', text: c }); i++; continue; }
    if (c === ')') { out.push({ kind: 'rp', text: c }); i++; continue; }
    if (c === '[') { out.push({ kind: 'lb', text: c }); i++; continue; }
    if (c === ']') { out.push({ kind: 'rb', text: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; s += src[j++]; }
      out.push({ kind: 'str', text: s });
      i = j + 1;
      continue;
    }
    if (c === '/' && out.length && out[out.length - 1].kind === 'op' && /[=!]~/.test(out[out.length - 1].text)) {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '/') { if (src[j] === '\\') { s += src[j++]; } s += src[j++]; }
      out.push({ kind: 're', text: s });
      i = j + 1;
      continue;
    }
    const op = /^(==|!=|<=|>=|=~|!~|<|>)/.exec(src.slice(i));
    if (op) { out.push({ kind: 'op', text: op[1] }); i += op[1].length; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ kind: 'num', text: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ kind: 'id', text: id[0] }); i += id[0].length; continue; }
    throw new Error(`unexpected "${c}"`);
  }
  return out;
}

export function evaluateCondition(src: string, lookup: Lookup): boolean {
  const t = tokenise(src);
  let p = 0;
  const peek = () => t[p];
  const take = () => t[p++];
  const expectKind = (k: Token['kind']) => {
    const tok = take();
    if (!tok || tok.kind !== k) throw new Error(`expected ${k}`);
    return tok;
  };

  const primary = (): Value => {
    const tok = take();
    if (!tok) throw new Error('unexpected end');
    switch (tok.kind) {
      case 'lp': {
        const v = or();
        expectKind('rp');
        return v;
      }
      case 'num': return Number(tok.text);
      case 'str': return tok.text;
      case 're': return new RegExp(tok.text);
      case 'id': {
        if (tok.text === 'true') return true;
        if (tok.text === 'false') return false;
        let index: number | null = null;
        if (peek()?.kind === 'lb') {
          take();
          index = Number(expectKind('num').text);
          expectKind('rb');
        }
        const v = lookup(tok.text, index);
        if (v === undefined) throw new Error(`unknown ${tok.text}`);
        return v;
      }
      default:
        throw new Error(`unexpected ${tok.text}`);
    }
  };

  const compare = (): Value => {
    const left = primary();
    const op = peek();
    if (op?.kind !== 'op') return left;
    take();
    const right = primary();
    switch (op.text) {
      case '=~': return right instanceof RegExp && right.test(String(left));
      case '!~': return right instanceof RegExp && !right.test(String(left));
    }
    const ln = Number(left), rn = Number(right);
    const numeric = typeof left !== 'boolean' && typeof right !== 'boolean' && left !== '' && right !== '' && Number.isFinite(ln) && Number.isFinite(rn);
    const a: number | string = numeric ? ln : String(left);
    const b: number | string = numeric ? rn : String(right);
    switch (op.text) {
      case '==': return numeric ? Math.abs((a as number) - (b as number)) < 1e-9 : a === b;
      case '!=': return numeric ? Math.abs((a as number) - (b as number)) >= 1e-9 : a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '<=': return a <= b;
      case '>=': return a >= b;
    }
    throw new Error(`operator ${op.text}`);
  };

  const not = (): Value => {
    if (peek()?.kind === 'id' && peek().text === 'not') {
      take();
      return !truthy(not());
    }
    return compare();
  };
  const and = (): Value => {
    let v = not();
    while (peek()?.kind === 'id' && peek().text === 'and') {
      take();
      const r = not();
      v = truthy(v) && truthy(r);
    }
    return v;
  };
  const or = (): Value => {
    let v = and();
    while (peek()?.kind === 'id' && peek().text === 'or') {
      take();
      const r = and();
      v = truthy(v) || truthy(r);
    }
    return v;
  };

  const v = or();
  if (p !== t.length) throw new Error('trailing input');
  return truthy(v);
}

function truthy(v: Value): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof RegExp) return true;
  return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** The lookup over a flattened machine preset, plus the two variables OrcaSlicer adds. */
export function machineLookup(machine: Record<string, string | string[]>, printerName: string): Lookup {
  return (name, index) => {
    if (name === 'printer_preset') return printerName;
    if (name === 'num_extruders') {
      const n = machine.nozzle_diameter;
      return String(Array.isArray(n) ? n.length : 1);
    }
    const v = machine[name];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) return v[index ?? 0];
    return index === null || index === 0 ? v : undefined;
  };
}
