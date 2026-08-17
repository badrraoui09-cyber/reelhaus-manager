// Test-only, minimal HTMLRewriter-compatible shim.
//
// Cloudflare's real HTMLRewriter only exists inside the Workers runtime —
// plain Node/vitest has no such global, which is why website-analysis.ts's
// analyzeReelHaus() (Client #0) has historically always failed with a
// "could not be analyzed" finding in this test suite rather than actually
// parsing HTML. That was an accepted limitation as long as nothing tested
// the parser's actual behavior. Task #5A-fix §1 reopened Client #0
// evidence correctness specifically (a label-detection bug), which can
// only be genuinely verified by running the real parseHtml()/inspectFacts()
// code against real HTML — not by hand-constructing HtmlFacts fixtures
// that assume the bug is already fixed.
//
// This file implements just the subset of the HTMLRewriter API and CSS
// selector syntax website-analysis.ts actually uses: tag selectors,
// [attr] / [attr='value'] predicates, a single level of descendant
// combinator ("a[href] img"), comma-separated selector lists, element()
// with getAttribute()/tagName/onEndTag(), and text() chunk callbacks. It
// is not a general CSS engine and is not meant to be — only meant to be a
// faithful enough HTML tokenizer that the real label/accessible-name
// detection logic runs unmodified against real markup in tests.
export type FakeElement = {
  tagName: string;
  getAttribute(name: string): string | null;
  onEndTag(callback: () => void): void;
};

export interface FakeElementHandlers {
  element?(element: FakeElement): void;
}

export interface FakeTextHandlers {
  text?(chunk: { text: string }): void;
}

type Handlers = FakeElementHandlers & FakeTextHandlers;

interface SimpleSelector {
  tag: string;
  attrExists: string[];
  attrEquals: Record<string, string>;
}

type ParsedSelector = SimpleSelector | { ancestor: SimpleSelector; descendant: SimpleSelector };

interface Frame {
  tag: string;
  attrs: Record<string, string>;
  endCallbacks: Array<() => void>;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

function parseSimpleSelector(part: string): SimpleSelector {
  const tagMatch = part.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  const tag = (tagMatch?.[0] || "*").toLowerCase();
  const attrExists: string[] = [];
  const attrEquals: Record<string, string> = {};
  const bracketRe = /\[([a-zA-Z-]+)(?:=(?:'([^']*)'|"([^"]*)"))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = bracketRe.exec(part))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3];
    if (value !== undefined) attrEquals[name] = value;
    else attrExists.push(name);
  }
  return { tag, attrExists, attrEquals };
}

function parseSelector(part: string): ParsedSelector {
  const trimmed = part.trim();
  const spaceIndex = trimmed.indexOf(" ");
  if (spaceIndex === -1) return parseSimpleSelector(trimmed);
  return {
    ancestor: parseSimpleSelector(trimmed.slice(0, spaceIndex)),
    descendant: parseSimpleSelector(trimmed.slice(spaceIndex + 1).trim())
  };
}

function parseSelectorList(selector: string): ParsedSelector[] {
  return selector.split(",").map(parseSelector);
}

function simpleMatches(simple: SimpleSelector, frame: Frame): boolean {
  if (simple.tag !== "*" && simple.tag !== frame.tag) return false;
  for (const attr of simple.attrExists)
    if (!Object.prototype.hasOwnProperty.call(frame.attrs, attr)) return false;
  for (const [key, value] of Object.entries(simple.attrEquals))
    if (frame.attrs[key] !== value) return false;
  return true;
}

function matchesForElement(
  selectors: ParsedSelector[],
  frame: Frame,
  ancestors: Frame[]
): boolean {
  return selectors.some((selector) => {
    if ("tag" in selector) return simpleMatches(selector, frame);
    return (
      simpleMatches(selector.descendant, frame) &&
      ancestors.some((ancestor) => simpleMatches(selector.ancestor, ancestor))
    );
  });
}

function findTagEnd(html: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return html.length - 1;
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[name] = value;
  }
  return attrs;
}

export class FakeHTMLRewriter {
  private readonly rules: Array<{ selectors: ParsedSelector[]; handlers: Handlers }> = [];

  on(selector: string, handlers: Handlers): this {
    this.rules.push({ selectors: parseSelectorList(selector), handlers });
    return this;
  }

  transform(response: Response): { arrayBuffer(): Promise<ArrayBuffer> } {
    const rules = this.rules;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        const html = await response.text();
        run(html, rules);
        return new ArrayBuffer(0);
      }
    };
  }
}

function run(html: string, rules: Array<{ selectors: ParsedSelector[]; handlers: Handlers }>): void {
  const stack: Frame[] = [];

  function handleOpen(tag: string, attrs: Record<string, string>, selfClosing: boolean): void {
    const frame: Frame = { tag, attrs, endCallbacks: [] };
    const isVoid = VOID_ELEMENTS.has(tag) || selfClosing;
    const ancestors = stack;
    for (const rule of rules) {
      if (!rule.handlers.element) continue;
      if (matchesForElement(rule.selectors, frame, ancestors)) {
        const element: FakeElement = {
          tagName: tag,
          getAttribute: (name) => {
            const key = name.toLowerCase();
            return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
          },
          onEndTag: (callback) => {
            if (isVoid) callback();
            else frame.endCallbacks.push(callback);
          }
        };
        rule.handlers.element(element);
      }
    }
    if (!isVoid) stack.push(frame);
  }

  function handleClose(tag: string): void {
    for (let index = stack.length - 1; index >= 0; index--) {
      if (stack[index].tag === tag) {
        const [closed] = stack.splice(index, 1);
        for (const callback of closed.endCallbacks) callback();
        return;
      }
    }
  }

  function handleText(text: string): void {
    if (!text) return;
    for (const rule of rules) {
      if (!rule.handlers.text) continue;
      const applies = stack.some((frame) =>
        rule.selectors.some((selector) => "tag" in selector && simpleMatches(selector, frame))
      );
      if (applies) rule.handlers.text({ text });
    }
  }

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      handleText(html.slice(i));
      break;
    }
    if (lt > i) handleText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html[lt + 1] === "/") {
      const end = html.indexOf(">", lt);
      if (end === -1) break;
      handleClose(html.slice(lt + 2, end).trim().toLowerCase());
      i = end + 1;
      continue;
    }

    const end = findTagEnd(html, lt);
    const raw = html.slice(lt + 1, end);
    const selfClosing = raw.trimEnd().endsWith("/");
    const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw;
    const tagNameMatch = body.match(/^[a-zA-Z][a-zA-Z0-9]*/);
    if (!tagNameMatch) {
      i = end + 1;
      continue;
    }
    const tag = tagNameMatch[0].toLowerCase();
    const attrs = parseAttrs(body.slice(tagNameMatch[0].length));
    handleOpen(tag, attrs, selfClosing);
    i = end + 1;
  }
}
