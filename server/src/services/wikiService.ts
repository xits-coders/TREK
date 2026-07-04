import path from 'path';
import { promises as fs } from 'fs';

/**
 * In-app Help/Wiki content, sourced from the TREK GitHub wiki (kept in the repo
 * under `wiki/**` and mirrored to the GitHub wiki on push to main). The server
 * fetches the markdown from GitHub and caches it, so the embedded help stays in
 * sync with wiki edits without a redeploy — and the client never talks to GitHub
 * directly (images are proxied too). A bundled snapshot under server/assets/wiki
 * is the cold-start / offline fallback.
 */

const REPO = 'mauriceboe/TREK';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main/wiki`;
const TTL_MS = 60 * 60 * 1000; // refresh from GitHub at most hourly
const SNAPSHOT_DIR = path.join(__dirname, '..', '..', 'assets', 'wiki');
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class WikiNotFound extends Error {
  status = 404;
}

interface TextEntry {
  data: string;
  ts: number;
}
const textCache = new Map<string, TextEntry>();
const assetCache = new Map<string, { buf: Buffer; type: string; ts: number }>();

const fresh = (ts: number): boolean => Date.now() - ts < TTL_MS;

async function readSnapshot(file: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(SNAPSHOT_DIR, file), 'utf8');
  } catch {
    return null;
  }
}

/** Fetch a wiki text file with cache → stale-cache → bundled-snapshot fallback. */
async function fetchText(file: string): Promise<string> {
  const cached = textCache.get(file);
  if (cached && fresh(cached.ts)) return cached.data;
  try {
    const res = await fetch(`${RAW_BASE}/${encodeURIComponent(file)}`, {
      headers: { 'User-Agent': 'TREK-help', Accept: 'text/plain' },
    });
    if (res.ok) {
      const text = await res.text();
      textCache.set(file, { data: text, ts: Date.now() });
      return text;
    }
    if (res.status === 404) throw new WikiNotFound(file);
  } catch (err) {
    if (err instanceof WikiNotFound) throw err;
    // network/parse error — fall through to stale cache or snapshot
  }
  if (cached) return cached.data; // serve stale rather than fail
  const snap = await readSnapshot(file);
  if (snap != null) {
    textCache.set(file, { data: snap, ts: Date.now() });
    return snap;
  }
  throw new WikiNotFound(file);
}

export interface WikiNavItem {
  title: string;
  slug: string;
}
export interface WikiNavSection {
  title: string;
  pages: WikiNavItem[];
}

/** Parse the wiki `_Sidebar.md` into ordered sections of `[[Title|Slug]]` links. */
function parseSidebar(md: string): WikiNavSection[] {
  const sections: WikiNavSection[] = [];
  let current: WikiNavSection | null = null;
  for (const raw of md.split('\n')) {
    const heading = raw.match(/^#{1,4}\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1].replace(/[*_`]/g, '').trim(), pages: [] };
      sections.push(current);
      continue;
    }
    const link = raw.match(/^\s*[-*]\s*\[\[([^\]]+)\]\]/);
    if (link) {
      if (!current) {
        current = { title: '', pages: [] };
        sections.push(current);
      }
      const inner = link[1];
      const [title, slugRaw] = inner.includes('|') ? inner.split('|') : [inner, inner];
      const slug = slugRaw.trim().replace(/\s+/g, '-');
      if (SLUG_RE.test(slug)) current.pages.push({ title: title.trim(), slug });
    }
  }
  return sections.filter((s) => s.pages.length > 0);
}

/** Rewrite GitHub-wiki `[[..]]` links to /help routes and proxy relative images. */
function processMarkdown(md: string): string {
  // Strip HTML comments (e.g. `<!-- TODO: screenshot … -->` placeholders) — the
  // markdown renderer would otherwise surface them as raw text.
  let out = md.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [title, slugRaw] = inner.includes('|') ? inner.split('|') : [inner, inner];
    const slug = slugRaw.trim().replace(/\s+/g, '-');
    return `[${title.trim()}](/help/${slug})`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (m, alt: string, url: string) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('/api/help/asset/')) return m;
    const clean = url.replace(/^\.?\//, '').replace(/^wiki\//, '');
    return `![${alt}](/api/help/asset/${clean})`;
  });
  return out;
}

function extractTitle(md: string, fallback: string): string {
  const h1 = md.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].replace(/[*_`]/g, '').trim() : fallback.replace(/-/g, ' ');
}

export interface WikiPage {
  slug: string;
  title: string;
  markdown: string;
}

export async function getWikiIndex(): Promise<{ sections: WikiNavSection[] }> {
  const md = await fetchText('_Sidebar.md');
  return { sections: parseSidebar(md) };
}

export async function getWikiPage(slug: string): Promise<WikiPage> {
  if (!SLUG_RE.test(slug)) throw new WikiNotFound(slug);
  const md = await fetchText(`${slug}.md`);
  return { slug, title: extractTitle(md, slug), markdown: processMarkdown(md) };
}

const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** Proxy a wiki image so the browser never calls GitHub directly. */
export async function getWikiAsset(assetPath: string): Promise<{ buf: Buffer; type: string }> {
  // Defend against traversal; allow nested image folders.
  if (assetPath.includes('..') || !/^[A-Za-z0-9/._-]+$/.test(assetPath)) throw new WikiNotFound(assetPath);
  const ext = path.extname(assetPath).toLowerCase();
  const type = ASSET_TYPES[ext];
  if (!type) throw new WikiNotFound(assetPath);

  const cached = assetCache.get(assetPath);
  if (cached && fresh(cached.ts)) return { buf: cached.buf, type: cached.type };
  try {
    const res = await fetch(`${RAW_BASE}/${assetPath.split('/').map(encodeURIComponent).join('/')}`, {
      headers: { 'User-Agent': 'TREK-help' },
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      assetCache.set(assetPath, { buf, type, ts: Date.now() });
      return { buf, type };
    }
  } catch {
    /* fall through */
  }
  if (cached) return { buf: cached.buf, type: cached.type };
  try {
    const buf = await fs.readFile(path.join(SNAPSHOT_DIR, assetPath));
    return { buf, type };
  } catch {
    throw new WikiNotFound(assetPath);
  }
}
