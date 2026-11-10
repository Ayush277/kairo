import { load } from "cheerio";
import { isTag, isText, type AnyNode, type Element } from "domhandler";

const UA = "Mozilla/5.0 (compatible; KairoBot/1.0; +https://localhost) AppleWebKit/537.36 Chrome/124 Safari/537.36";
const DROP = new Set(["script", "style", "noscript", "svg", "iframe", "template", "nav", "footer", "form", "dialog", "button", "select", "head"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "aside", "ul", "ol", "li", "tr", "table", "pre", "blockquote", "dl", "dt", "dd", "figure"]);

export interface PageResult {
  url: string;
  title: string;
  markdown: string;
  via: "direct" | "jina" | "cache";
}

const cache = new Map<string, { at: number; value: PageResult }>();
const CACHE_TTL_MS = 10 * 60_000;

export function isPublicHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "[::1]") return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Fetch a page and compress it to Markdown that preserves headings, lists, tables and prices. */
export async function readPage(url: string, opts: { signal?: AbortSignal; maxChars?: number } = {}): Promise<PageResult> {
  const maxChars = opts.maxChars ?? 6000;
  if (!isPublicHttpUrl(url)) throw new Error("URL is not a public http(s) address");

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, markdown: focusPricing(hit.value.markdown, maxChars), via: "cache" };

  let result: PageResult | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: opts.signal,
    });
    const type = res.headers.get("content-type") ?? "";
    if (res.ok && /html|xml|text/.test(type)) {
      const html = (await res.text()).slice(0, 2_000_000);
      const { title, markdown } = htmlToMarkdown(html);
      result = { url, title, markdown, via: "direct" };
    }
  } catch (err) {
    if (opts.signal?.aborted) throw err;
  }

  // JS-rendered or bot-blocked pages come back nearly empty: retry through Jina Reader, which renders server-side.
  if (!result || result.markdown.length < 400) {
    try {
      const res = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
        signal: opts.signal,
      });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text.length > (result?.markdown.length ?? 0)) {
          result = { url, title: /^Title:\s*(.+)$/m.exec(text)?.[1] ?? result?.title ?? url, markdown: tidy(text), via: "jina" };
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
    }
  }
  if (!result || !result.markdown) throw new Error("page returned no readable content");

  cache.set(url, { at: Date.now(), value: result });
  return { ...result, markdown: focusPricing(result.markdown, maxChars) };
}

export function htmlToMarkdown(html: string): { title: string; markdown: string } {
  const $ = load(html);
  const title = $("title").first().text().trim();
  const rootEl = $("main, [role=main], article").first();
  const root = (rootEl.length ? rootEl : $("body")).get(0);
  if (!root) return { title, markdown: "" };
  return { title, markdown: tidy(block(root)) };
}

function inline(node: AnyNode): string {
  if (isText(node)) return node.data.replace(/\s+/g, " ");
  if (!isTag(node) || DROP.has(node.name)) return "";
  if (node.name === "br") return "\n";
  return node.children.map(inline).join("");
}

function table(el: Element): string {
  const rows: string[][] = [];
  const walk = (n: AnyNode) => {
    if (!isTag(n)) return;
    if (n.name === "tr") {
      const cells = n.children.filter((c): c is Element => isTag(c) && (c.name === "td" || c.name === "th"));
      if (cells.length) rows.push(cells.map((c) => inline(c).replace(/\s+/g, " ").replace(/\|/g, "/").trim()));
    } else n.children.forEach(walk);
  };
  walk(el);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const fmt = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  const [head, ...body] = rows;
  return `\n\n${fmt(head!)}\n|${" --- |".repeat(width)}\n${body.map(fmt).join("\n")}\n\n`;
}

function block(node: AnyNode): string {
  if (isText(node)) return node.data.replace(/\s+/g, " ");
  if (!isTag(node) || DROP.has(node.name)) return "";
  const name = node.name;
  if (name === "table") return table(node);
  if (/^h[1-6]$/.test(name)) {
    const text = inline(node).trim();
    return text ? `\n\n${"#".repeat(Number(name[1]))} ${text}\n\n` : "";
  }
  if (name === "li") {
    const text = node.children.map(block).join("").replace(/\s+/g, " ").trim();
    return text ? `\n- ${text}` : "";
  }
  if (name === "pre") return `\n\n\`\`\`\n${inline(node).trim()}\n\`\`\`\n\n`;
  const inner = node.children.map(block).join("");
  return BLOCK.has(name) ? `\n${inner}\n` : inner;
}

function tidy(md: string): string {
  const lines = md
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && out[out.length - 1] === "") continue;
    if (l !== "" && l === out[out.length - 1] && !l.startsWith("|")) continue;
    out.push(l);
  }
  return out.join("\n").trim();
}

const PRICE_LINE = /[$€£₹]\s?\d|\d\s?(?:\/|per)\s?(?:mo|month|seat|user|member|yr|year|gb|hour|hr)|\bfree\b|\bplan\b|\btier\b|\bseat|\bminimum\b|\bcompute\b|\bstorage\b|\bbilled\b|\bannual|\bmonthly\b|\bunlimited\b|\bincluded?\b|\bv?\d+\.\d+\b|\bchangelog\b|\breleas/i;

/**
 * Pricing pages are long and mostly marketing. When over budget, keep headings plus every line that mentions a
 * price, plan, tier or limit, so the model sees the whole price list instead of the first N characters.
 */
export function focusPricing(md: string, maxChars: number): string {
  if (md.length <= maxChars) return md;
  const lines = md.split("\n");
  const keep = lines.map((l) => l.startsWith("#") || l.startsWith("|") || PRICE_LINE.test(l));
  const out: string[] = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    const l = lines[i] as string;
    const clipped = l.length > 300 ? `${l.slice(0, 300)}…` : l;
    if (size + clipped.length + 1 > maxChars) break;
    out.push(clipped);
    size += clipped.length + 1;
  }
  return out.length ? out.join("\n") : md.slice(0, maxChars);
}
