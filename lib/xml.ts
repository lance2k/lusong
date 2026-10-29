/**
 * A small namespace-aware XML reader for the PAGASA feed and its CAP records. It accepts well-formed XML without a
 * DOCTYPE and throws XmlError on anything else, so a broken or unexpected document is never half-read.
 */

export class XmlError extends Error {}

export interface XmlElement {
  /** Namespace URI, or null for an element in no namespace. */
  ns: string | null;
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own character data, children's text excluded. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Far above the PAGASA feed (about 400 elements, depth 4) and its CAP records (about 60, depth 6). */
export const MAX_DEPTH = 32;
export const MAX_ELEMENTS = 5_000;
export const MAX_NAMESPACE_DECLARATIONS = 32;

/** XML 1.0's Char production. */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

const REFERENCE = /&(?:#x([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([A-Za-z]+));|&/g;

function decode(raw: string): string {
  return raw.replace(REFERENCE, (whole, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (whole === "&") throw new XmlError("an & that starts no well-formed reference");
    if (name !== undefined) {
      const value = ENTITIES[name];
      if (value === undefined) throw new XmlError(`unknown entity &${name};`);
      return value;
    }
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    if (!isXmlChar(cp)) throw new XmlError(`&#${hex ?? dec}; is not an XML character`);
    return String.fromCodePoint(cp);
  });
}

const NAME = /[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/y;
const ATTR = /\s+([A-Za-z_][\w.\-:]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;

/** Sticky match at `at`, so no substring of the document is copied per tag. */
function matchAt(re: RegExp, source: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(source);
}

interface Open {
  el: XmlElement;
  qname: string;
  scope: Record<string, string | null>;
}

export function parseXml(source: string): XmlElement {
  let i = 0;
  let root: XmlElement | null = null;
  const stack: Open[] = [];
  let elements = 0;
  let declarations = 0;
  const baseScope: Record<string, string | null> = { "": null, xml: "http://www.w3.org/XML/1998/namespace" };

  const resolve = (qname: string, scope: Record<string, string | null>): { ns: string | null; name: string } => {
    const colon = qname.indexOf(":");
    const prefix = colon < 0 ? "" : qname.slice(0, colon);
    if (!(prefix in scope)) throw new XmlError(`unbound prefix ${prefix}`);
    return { ns: scope[prefix], name: colon < 0 ? qname : qname.slice(colon + 1) };
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    const textEnd = lt < 0 ? source.length : lt;
    if (textEnd > i) {
      const text = source.slice(i, textEnd);
      if (stack.length > 0) stack[stack.length - 1].el.text += decode(text);
      else if (text.trim() !== "") throw new XmlError("text outside the root element");
    }
    if (lt < 0) break;
    i = lt;

    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i);
      if (end < 0) throw new XmlError("unclosed processing instruction");
      i = end + 2;
    } else if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i);
      if (end < 0) throw new XmlError("unclosed comment");
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i);
      if (end < 0 || stack.length === 0) throw new XmlError("bad CDATA");
      stack[stack.length - 1].el.text += source.slice(i + 9, end);
      i = end + 3;
    } else if (source.startsWith("<!", i)) {
      throw new XmlError("DOCTYPE and declarations are not accepted");
    } else if (source.startsWith("</", i)) {
      const m = matchAt(NAME, source, i + 2);
      const close = m ? source.indexOf(">", i) : -1;
      if (!m || close < 0 || source.slice(i + 2 + m[0].length, close).trim() !== "") throw new XmlError("bad end tag");
      const open = stack.pop();
      if (!open || open.qname !== m[0]) throw new XmlError(`mismatched </${m[0]}>`);
      i = close + 1;
    } else {
      const m = matchAt(NAME, source, i + 1);
      if (!m) throw new XmlError("bad start tag");
      if (root && stack.length === 0) throw new XmlError("a second root element");
      const qname = m[0];
      i += 1 + qname.length;
      const raw: Record<string, string> = {};
      for (;;) {
        const a = matchAt(ATTR, source, i);
        if (!a) break;
        if (a[1] in raw) throw new XmlError(`duplicate attribute ${a[1]}`);
        raw[a[1]] = decode(a[3] ?? a[4] ?? "");
        i += a[0].length;
      }
      const rest = matchAt(TAG_END, source, i);
      if (!rest) throw new XmlError(`bad start tag <${qname}>`);
      i += rest[0].length;

      if (++elements > MAX_ELEMENTS) throw new XmlError(`more than ${MAX_ELEMENTS} elements`);
      if (stack.length >= MAX_DEPTH) throw new XmlError(`nested deeper than ${MAX_DEPTH}`);
      // A child shares its parent's scope unless it declares a namespace, so scopes are not copied per element.
      const parentScope = stack.length > 0 ? stack[stack.length - 1].scope : baseScope;
      const declared = Object.keys(raw).filter((k) => k === "xmlns" || k.startsWith("xmlns:"));
      declarations += declared.length;
      if (declarations > MAX_NAMESPACE_DECLARATIONS) throw new XmlError(`more than ${MAX_NAMESPACE_DECLARATIONS} namespace declarations`);
      const scope = declared.length === 0 ? parentScope : { ...parentScope };
      for (const k of declared) {
        if (k === "xmlns") scope[""] = raw[k] === "" ? null : raw[k];
        else scope[k.slice(6)] = raw[k];
      }
      const el: XmlElement = { ...resolve(qname, scope), attrs: raw, children: [], text: "" };
      if (stack.length > 0) stack[stack.length - 1].el.children.push(el);
      else root = el;
      if (rest[1] !== "/") stack.push({ el, qname, scope });
    }
  }
  if (!root || stack.length > 0) throw new XmlError("document ended before the root element closed");
  return root;
}

export function childrenOf(el: XmlElement, ns: string, name: string): XmlElement[] {
  return el.children.filter((c) => c.ns === ns && c.name === name);
}

export function childOf(el: XmlElement, ns: string, name: string): XmlElement | undefined {
  return el.children.find((c) => c.ns === ns && c.name === name);
}

export function textOf(el: XmlElement | undefined, ns: string, name: string): string | null {
  const child = el && childOf(el, ns, name);
  return child ? child.text.trim() : null;
}
