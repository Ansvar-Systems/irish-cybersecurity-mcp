/**
 * NCSC-IE Ingestion Crawler
 *
 * Scrapes the NCSC Ireland website (ncsc.gov.ie) and populates the SQLite
 * database with real guidance documents and security advisories.
 *
 * Data sources:
 *   1. Guidance documents — RSS feed at ncsc.gov.ie/guidance/guidance.rss
 *      (28 documents: standards, quick guides, frameworks)
 *   2. NIS2 guidance — ncsc.gov.ie/nis2/ (NIS2-specific documents)
 *   3. Security advisories — ncsc.gov.ie/news/ (alerts & advisories listing,
 *      each linking to a PDF advisory)
 *
 * The crawler fetches HTML listing pages and the guidance RSS feed to extract
 * metadata, then fetches individual PDF advisory pages where possible. All
 * content is in English.
 *
 * Usage:
 *   npx tsx scripts/ingest-ncsc-ie.ts                    # full crawl
 *   npx tsx scripts/ingest-ncsc-ie.ts --resume            # resume from last checkpoint
 *   npx tsx scripts/ingest-ncsc-ie.ts --dry-run           # log what would be inserted
 *   npx tsx scripts/ingest-ncsc-ie.ts --force             # drop and recreate DB first
 *   npx tsx scripts/ingest-ncsc-ie.ts --advisories-only   # only crawl advisories
 *   npx tsx scripts/ingest-ncsc-ie.ts --guidance-only     # only crawl guidance
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["NCSC_IE_DB_PATH"] ?? "data/ncsc-ie.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.ncsc.gov.ie";
const NEWS_URL = `${BASE_URL}/news/`;
const GUIDANCE_RSS_URL = `${BASE_URL}/guidance/guidance.rss`;
const NIS2_URL = `${BASE_URL}/nis2/`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const USER_AGENT =
  "AnsvarNCSCIECrawler/1.0 (+https://ansvar.eu; compliance research)";

// CLI flags
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const advisoriesOnly = args.includes("--advisories-only");
const guidanceOnly = args.includes("--guidance-only");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GuidanceRow {
  reference: string;
  title: string;
  title_en: string | null;
  date: string | null;
  type: string;
  series: string;
  summary: string;
  full_text: string;
  topics: string;
  status: string;
}

interface AdvisoryRow {
  reference: string;
  title: string;
  date: string | null;
  severity: string | null;
  affected_products: string | null;
  summary: string;
  full_text: string;
  cve_references: string | null;
}

interface FrameworkRow {
  id: string;
  name: string;
  name_en: string | null;
  description: string;
  document_count: number;
}

interface Progress {
  completed_guidance_refs: string[];
  completed_advisory_refs: string[];
  completed_nis2_refs: string[];
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Utility: rate-limited fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
        ...opts,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  [retry ${attempt}/${MAX_RETRIES}] ${url}: ${lastError.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError!;
}

async function fetchText(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  return resp.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// HTML text extraction
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&rdquo;/g, "\u201D")
    .replace(/&ldquo;/g, "\u201C")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&eacute;/g, "\u00E9")
    .replace(/&oacute;/g, "\u00F3")
    .replace(/&#\d+;/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// XML RSS parser (minimal, no external dependency)
// ---------------------------------------------------------------------------

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(xml)) !== null) {
    const itemXml = itemMatch[1]!;

    const getTag = (tag: string): string => {
      const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
      const m = re.exec(itemXml);
      return m?.[1]?.trim() ?? "";
    };

    items.push({
      title: getTag("title"),
      link: getTag("link"),
      description: getTag("description"),
      pubDate: getTag("pubDate") || null,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const p = JSON.parse(raw) as Progress;
      console.log(
        `Resuming from checkpoint (${p.last_updated}): ` +
          `${p.completed_guidance_refs.length} guidance, ` +
          `${p.completed_advisory_refs.length} advisories, ` +
          `${p.completed_nis2_refs.length} NIS2 docs`,
      );
      return p;
    } catch {
      console.warn("Could not parse progress file, starting fresh");
    }
  }
  return {
    completed_guidance_refs: [],
    completed_advisory_refs: [],
    completed_nis2_refs: [],
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  console.log(`Database initialised at ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Framework definitions (static)
// ---------------------------------------------------------------------------

const FRAMEWORKS: FrameworkRow[] = [
  {
    id: "ncsc-ie-guidance",
    name: "NCSC-IE Guidance Series",
    name_en: "NCSC Ireland Guidance Series",
    description:
      "Official cybersecurity guidance from the National Cyber Security Centre Ireland. " +
      "Covers network security, cloud, ransomware, incident response, operational technology, " +
      "generative AI, mobile device management, phishing, and baseline standards for " +
      "public sector bodies. Based on NIST Cyber Security Framework.",
    document_count: 0,
  },
  {
    id: "nis2-ie",
    name: "NIS2 Implementation — Ireland",
    name_en: "NIS2 Directive Implementation in Ireland",
    description:
      "Guidance on Directive (EU) 2022/2555 (NIS2) as transposed into Irish law. " +
      "Covers essential and important entity obligations, risk management measures, " +
      "incident reporting timelines (24h/72h/1 month), supply chain security, and " +
      "penalties (up to EUR 10M or 2% turnover for essential entities).",
    document_count: 0,
  },
  {
    id: "ncsc-ie-advisories",
    name: "NCSC-IE Security Advisories",
    name_en: "NCSC Ireland Security Advisories and Alerts",
    description:
      "Security advisories and alerts published by NCSC-IE / CSIRT-IE on critical " +
      "vulnerabilities, active exploits, and threat actor activity affecting Irish " +
      "organisations. Covers enterprise software, network appliances, cloud services, " +
      "and consumer threats.",
    document_count: 0,
  },
];

// ---------------------------------------------------------------------------
// 1. Crawl guidance documents via RSS feed
// ---------------------------------------------------------------------------

/**
 * Classify a guidance document by type based on its title and URL.
 */
function classifyGuidanceType(title: string, url: string): string {
  const lower = title.toLowerCase();
  if (/quick guide/i.test(lower)) return "quick_guide";
  if (/baseline.*standard/i.test(lower) || /self-assessment/i.test(lower))
    return "standard";
  if (/framework/i.test(lower) || /emergency.*plan/i.test(lower))
    return "standard";
  if (/nis\s*2|nis2/i.test(lower)) return "standard";
  if (/template/i.test(lower)) return "template";
  if (/guidelines|specifications/i.test(lower)) return "guideline";
  if (/\.xlsx$/i.test(url)) return "template";
  return "guidance";
}

/**
 * Classify a guidance document into a series.
 */
function classifyGuidanceSeries(title: string): string {
  const lower = title.toLowerCase();
  if (/nis\s*2|nis2|nis.*compliance/i.test(lower)) return "NIS2-IE";
  return "NCSC-IE";
}

/**
 * Detect topics from guidance document title and description.
 */
function detectGuidanceTopics(title: string, description: string): string[] {
  const topics: string[] = [];
  const text = `${title} ${description}`.toLowerCase();

  const topicPatterns: Array<[RegExp, string]> = [
    [/ransomware/i, "ransomware"],
    [/phishing|spear.?phish/i, "phishing"],
    [/incident.*respon|ir\b/i, "incident-response"],
    [/business.*email.*compromise|bec\b/i, "business-email-compromise"],
    [/denial.*service|dos\b|ddos/i, "denial-of-service"],
    [/nis\s*2|nis2/i, "NIS2"],
    [/cloud/i, "cloud"],
    [/election|electoral|political/i, "election-security"],
    [/school/i, "education"],
    [/sme|small.*business/i, "small-business"],
    [/mobile.*device|mdm/i, "mobile-security"],
    [/mfa|multi.?factor|authentication/i, "authentication"],
    [/office\s*365|microsoft\s*365/i, "office-365"],
    [/operational.*tech|ot\b|scada|ics/i, "operational-technology"],
    [/generative.*ai|genai|artificial.*intell/i, "generative-ai"],
    [/baseline.*standard|security.*baseline/i, "baseline-standards"],
    [/procurement|ict.*procurement/i, "procurement"],
    [/critical.*infra/i, "critical-infrastructure"],
    [/supply.*chain/i, "supply-chain"],
    [/working.*home|remote.*work|wfh/i, "remote-working"],
    [/backup/i, "backup"],
    [/qr.*code/i, "qr-code-scam"],
    [/gdpr|data.*protect/i, "data-protection"],
    [/emergency.*plan|cyber.*emergency/i, "emergency-planning"],
    [/awareness|seasonal/i, "awareness"],
    [/account.*security|password/i, "account-security"],
    [/vpn/i, "vpn"],
    [/patch|vulnerabilit/i, "vulnerability-management"],
    [/network.*segmentation/i, "network-security"],
  ];

  for (const [pattern, topic] of topicPatterns) {
    if (pattern.test(text) && !topics.includes(topic)) {
      topics.push(topic);
    }
  }

  return topics.length > 0 ? topics : ["cybersecurity"];
}

/**
 * Generate a stable reference ID from a guidance document's PDF URL.
 */
function guidanceRefFromUrl(url: string, title: string): string {
  // Extract filename from URL, remove extension
  const filename = url.split("/").pop()?.replace(/\.(pdf|xlsx)$/i, "") ?? "";

  // Try to create a readable reference from the filename
  const cleaned = filename
    .replace(/[-_]+/g, "-")
    .replace(/\s+/g, "-")
    .toUpperCase();

  // If filename is too long or opaque, create from title
  if (cleaned.length > 60 || cleaned.length < 3) {
    const slug = title
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .replace(/\s+/g, "-")
      .toUpperCase()
      .slice(0, 50);
    return `NCSC-IE-G-${slug}`;
  }

  return `NCSC-IE-G-${cleaned}`;
}

interface GuidanceRssEntry {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
}

async function fetchGuidanceFromRss(): Promise<GuidanceRssEntry[]> {
  console.log("\n--- Fetching guidance documents from RSS feed ---");
  const xml = await fetchText(GUIDANCE_RSS_URL);
  const items = parseRssItems(xml);
  console.log(`  RSS feed returned ${items.length} items`);

  const entries: GuidanceRssEntry[] = [];

  for (const item of items) {
    if (!item.title || !item.link) continue;

    // Skip Irish language versions (duplicate content)
    if (/irish\s+version/i.test(item.title)) {
      console.log(`  Skipping Irish language version: ${item.title}`);
      continue;
    }

    entries.push({
      title: item.title,
      link: item.link,
      description: htmlToText(item.description),
      pubDate: item.pubDate,
    });
  }

  console.log(`  Found ${entries.length} guidance documents (English)`);
  return entries;
}

function guidanceRssToRow(entry: GuidanceRssEntry): GuidanceRow {
  // Parse date from pubDate (RFC 2822 format)
  let date: string | null = null;
  if (entry.pubDate) {
    try {
      const d = new Date(entry.pubDate);
      if (!isNaN(d.getTime())) {
        date = d.toISOString().slice(0, 10);
      }
    } catch {
      // ignore invalid dates
    }
  }

  const reference = guidanceRefFromUrl(entry.link, entry.title);
  const type = classifyGuidanceType(entry.title, entry.link);
  const series = classifyGuidanceSeries(entry.title);
  const topics = detectGuidanceTopics(entry.title, entry.description);

  // Build full_text from description (RSS provides the description;
  // PDFs are binary and cannot be parsed without additional dependencies)
  const fullText =
    `${entry.title}\n\n${entry.description}`.trim() || entry.title;

  return {
    reference,
    title: entry.title,
    title_en: entry.title, // NCSC-IE publishes in English
    date,
    type,
    series,
    summary: entry.description.slice(0, 2000),
    full_text: fullText.slice(0, 50_000),
    topics: JSON.stringify(topics),
    status: "current",
  };
}

// ---------------------------------------------------------------------------
// 2. Crawl NIS2 page for additional documents
// ---------------------------------------------------------------------------

interface Nis2Entry {
  title: string;
  url: string;
  description: string;
}

async function fetchNis2Documents(): Promise<Nis2Entry[]> {
  console.log("\n--- Fetching NIS2 documents ---");
  const html = await fetchText(NIS2_URL);
  const $ = cheerio.load(html);

  const entries: Nis2Entry[] = [];
  const seenUrls = new Set<string>();

  // Find PDF links on the NIS2 page
  $('a[href$=".pdf"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    if (seenUrls.has(fullUrl)) return;
    seenUrls.add(fullUrl);

    const title = $(el).text().trim();
    if (!title || title.length < 3) return;

    // Skip if this is already in the guidance RSS (avoid duplicates)
    if (/Draft_Risk_Management/i.test(href)) return;

    // Get surrounding context for description
    const parent = $(el).parent();
    const description = parent.text().trim().replace(/\s+/g, " ");

    entries.push({
      title,
      url: fullUrl,
      description: description.slice(0, 500),
    });
  });

  console.log(`  Found ${entries.length} NIS2-specific documents`);
  return entries;
}

function nis2EntryToRow(entry: Nis2Entry): GuidanceRow {
  const reference = guidanceRefFromUrl(entry.url, entry.title);
  const topics = detectGuidanceTopics(entry.title, entry.description);
  if (!topics.includes("NIS2")) topics.unshift("NIS2");

  return {
    reference,
    title: entry.title,
    title_en: entry.title,
    date: null, // NIS2 page does not provide dates in listing
    type: "standard",
    series: "NIS2-IE",
    summary: entry.description.slice(0, 2000),
    full_text: `${entry.title}\n\n${entry.description}`.trim(),
    topics: JSON.stringify(topics),
    status: "current",
  };
}

// ---------------------------------------------------------------------------
// 3. Crawl security advisories from ncsc.gov.ie/news/
// ---------------------------------------------------------------------------

interface NewsAdvisory {
  date: string;
  title: string;
  pdfPath: string;
  pdfUrl: string;
}

/**
 * Parse the advisory listing page. Each entry is a link with format:
 *   [DD-MM-YYYY Title](/pdfs/filename.pdf)
 *
 * Entries are grouped under year headings (h2/h3).
 */
async function fetchAdvisoryListing(): Promise<NewsAdvisory[]> {
  console.log("\n--- Fetching advisory listing from news page ---");
  const html = await fetchText(NEWS_URL);
  const $ = cheerio.load(html);

  const advisories: NewsAdvisory[] = [];
  const seenRefs = new Set<string>();

  // Find all links to PDFs in the news page
  $('a[href*="/pdfs/"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const linkText = $(el).text().trim();
    if (!linkText || linkText.length < 5) return;

    // Parse date from the beginning of the link text: DD-MM-YYYY
    const dateMatch = linkText.match(/^(\d{2})-(\d{2})-(\d{4})\s+(.*)/);
    if (!dateMatch) return;

    const day = dateMatch[1]!;
    const month = dateMatch[2]!;
    const year = dateMatch[3]!;
    const title = dateMatch[4]!.trim();
    const date = `${year}-${month}-${day}`;

    const pdfPath = href.startsWith("/") ? href : `/${href}`;
    const pdfUrl = `${BASE_URL}${pdfPath}`;

    if (seenRefs.has(pdfUrl)) return;
    seenRefs.add(pdfUrl);

    advisories.push({ date, title, pdfPath, pdfUrl });
  });

  // If cheerio did not find date-prefixed links (structure changed),
  // fall back to regex parsing of raw HTML
  if (advisories.length === 0) {
    console.log("  Cheerio PDF-link parse yielded 0 results, trying regex fallback");
    const linkRe =
      /<a[^>]+href="([^"]*\/pdfs\/[^"]+)"[^>]*>\s*(\d{2})-(\d{2})-(\d{4})\s+([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
      const href = m[1]!;
      const day = m[2]!;
      const month = m[3]!;
      const year = m[4]!;
      const title = htmlToText(m[5]!).trim();
      const date = `${year}-${month}-${day}`;
      const pdfPath = href.startsWith("/") ? href : `/${href}`;
      const pdfUrl = `${BASE_URL}${pdfPath}`;

      if (seenRefs.has(pdfUrl)) continue;
      seenRefs.add(pdfUrl);

      advisories.push({ date, title, pdfPath, pdfUrl });
    }
  }

  console.log(`  Found ${advisories.length} advisories`);
  return advisories;
}

/**
 * Generate a stable reference for an advisory based on its PDF filename.
 * Examples:
 *   2603190024_CVE-2026-20963.pdf  -> NCSC-IE-ADV-2603190024
 *   CrowdStrike_BSOD_Loop_Issue.pdf -> NCSC-IE-ADV-CROWDSTRIKE-BSOD-LOOP-ISSUE
 */
function advisoryRefFromPdf(pdfPath: string): string {
  const filename =
    pdfPath.split("/").pop()?.replace(/\.pdf$/i, "") ?? "unknown";

  // If filename starts with a numeric code (YYMMDDHHMM pattern), use that
  const numericMatch = filename.match(/^(\d{10,})/);
  if (numericMatch) {
    return `NCSC-IE-ADV-${numericMatch[1]}`;
  }

  // Otherwise create from filename
  const slug = filename
    .replace(/[-_]+/g, "-")
    .replace(/\s+/g, "-")
    .toUpperCase()
    .slice(0, 60);
  return `NCSC-IE-ADV-${slug}`;
}

/**
 * Extract CVE references from advisory title and content.
 */
function extractCves(text: string): string[] {
  const cves: string[] = [];
  const cveRe = /CVE-\d{4}-\d{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = cveRe.exec(text)) !== null) {
    if (!cves.includes(m[0])) {
      cves.push(m[0]);
    }
  }
  return cves;
}

/**
 * Extract affected products from advisory title.
 * The NCSC-IE advisory titles typically name the vendor and product.
 */
function extractAffectedProducts(title: string): string[] {
  const products: string[] = [];

  // Common vendor/product patterns in NCSC-IE titles
  const productPatterns: Array<[RegExp, string]> = [
    [/\bMicrosoft\s+(\w[\w\s]*?)(?:\s+(?:Critical|Remote|Multiple|Vulnerability|Authentication))/i, "Microsoft $1"],
    [/\bCisco\s+(\w[\w\s]*?)(?:\s+(?:Critical|Remote|Multiple|Vulnerability|Authentication))/i, "Cisco $1"],
    [/\bFortinet\s+(\w[\w\s]*?)(?:\s+(?:Critical|Remote|Multiple|Vulnerability|Authentication|OS))/i, "Fortinet $1"],
    [/\bFortiOS\b/i, "Fortinet FortiOS"],
    [/\bFortiWeb\b/i, "Fortinet FortiWeb"],
    [/\bFortiProxy\b/i, "Fortinet FortiProxy"],
    [/\bFortiManager\b/i, "Fortinet FortiManager"],
    [/\bFortiSwitch\b/i, "Fortinet FortiSwitch"],
    [/\bIvanti\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Ivanti $1"],
    [/\bVeeam\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Veeam $1"],
    [/\bVMware\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "VMware $1"],
    [/\bPalo\s+Alto\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability|,)/i, "Palo Alto $1"],
    [/\bSAP\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "SAP $1"],
    [/\bOracle\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Oracle $1"],
    [/\bApache\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability|:)/i, "Apache $1"],
    [/\bSonicWall\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "SonicWall $1"],
    [/\bCitrix\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Citrix $1"],
    [/\bNetScaler\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Citrix NetScaler $1"],
    [/\bJuniper\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Juniper $1"],
    [/\bAdobe\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Adobe $1"],
    [/\bGoogle\s+Chrome\b/i, "Google Chrome"],
    [/\bFirefox\b/i, "Mozilla Firefox"],
    [/\bOpenSSH\b/i, "OpenSSH"],
    [/\bMOVEit\b/i, "Progress MOVEit"],
    [/\bCrushFTP\b/i, "CrushFTP"],
    [/\bAtlassian\s+(\w[\w\s]*?)(?:\s+\(|\s+Critical|\s+Vulnerability)/i, "Atlassian $1"],
    [/\bJenkins\b/i, "Jenkins"],
    [/\bConnectWise\b/i, "ConnectWise"],
    [/\bLiteSpeed\b/i, "LiteSpeed Cache"],
    [/\bGeoServer\b/i, "GeoServer"],
    [/\bServiceNow\b/i, "ServiceNow"],
    [/\bApple\b/i, "Apple"],
    [/\bRedis\b/i, "Redis"],
    [/\bMongoDB\b/i, "MongoDB"],
    [/\bMattermost\b/i, "Mattermost"],
    [/\bJetBrains\s+TeamCity\b/i, "JetBrains TeamCity"],
    [/\bKubernetes\b/i, "Kubernetes"],
    [/\bWazuh\b/i, "Wazuh"],
    [/\bSitecore\b/i, "Sitecore"],
    [/\bPlesk\b/i, "Plesk"],
    [/\bBeyondTrust\b/i, "BeyondTrust"],
    [/\bZyxel\b/i, "Zyxel"],
    [/\bCrowdStrike\b/i, "CrowdStrike"],
    [/\bBarracuda\b/i, "Barracuda"],
    [/\bPaperCut\b/i, "PaperCut"],
  ];

  for (const [pattern, product] of productPatterns) {
    const m = pattern.exec(title);
    if (m) {
      // Replace $1 with captured group if present
      const resolved = product.includes("$1") && m[1]
        ? product.replace("$1", m[1].trim())
        : product;
      if (!products.includes(resolved)) {
        products.push(resolved);
      }
    }
  }

  return products;
}

/**
 * Infer severity from advisory title.
 * NCSC-IE titles commonly include "Critical", "High severity", etc.
 */
function inferSeverity(title: string): string {
  const lower = title.toLowerCase();
  if (/critical/i.test(lower)) return "critical";
  if (/high\s+severity/i.test(lower)) return "high";
  if (/multiple.*vulnerabilit/i.test(lower)) return "high";
  if (/zero.?day/i.test(lower)) return "critical";
  if (/active.*exploit/i.test(lower)) return "critical";
  if (/remote.*code.*execution|rce/i.test(lower)) return "critical";
  if (/authentication.*bypass/i.test(lower)) return "critical";
  if (/scam|fraud|awareness|advisory/i.test(lower)) return "medium";
  return "high"; // NCSC-IE typically publishes high/critical advisories
}

/**
 * Detect topics for an advisory.
 */
function detectAdvisoryTopics(title: string): string[] {
  const topics: string[] = [];
  const lower = title.toLowerCase();

  const topicPatterns: Array<[RegExp, string]> = [
    [/ransomware/i, "ransomware"],
    [/vpn|ssl.?vpn/i, "vpn"],
    [/remote.*code.*execution|rce/i, "rce"],
    [/authentication.*bypass/i, "authentication-bypass"],
    [/command.*injection/i, "command-injection"],
    [/sql.*injection/i, "sql-injection"],
    [/zero.?day/i, "zero-day"],
    [/supply.*chain/i, "supply-chain"],
    [/malware/i, "malware"],
    [/scam|phishing|fraud/i, "social-engineering"],
    [/exchange|email/i, "email-security"],
    [/firewall|fortigate|palo.*alto|sonicwall/i, "network-appliance"],
    [/web.*server|apache|iis/i, "web-server"],
    [/cloud|saas/i, "cloud"],
    [/container|kubernetes|docker/i, "container"],
    [/windows|microsoft/i, "microsoft"],
    [/linux|unix/i, "linux"],
    [/mobile|android|ios|apple/i, "mobile"],
  ];

  for (const [pattern, topic] of topicPatterns) {
    if (pattern.test(lower) && !topics.includes(topic)) {
      topics.push(topic);
    }
  }

  return topics;
}

function advisoryToRow(adv: NewsAdvisory): AdvisoryRow {
  const reference = advisoryRefFromPdf(adv.pdfPath);
  const cves = extractCves(`${adv.title} ${adv.pdfPath}`);
  const products = extractAffectedProducts(adv.title);
  const severity = inferSeverity(adv.title);

  // Build summary and full_text from available metadata.
  // The actual content is in PDFs which are binary; we store the structured
  // metadata we can extract from the listing page.
  const topics = detectAdvisoryTopics(adv.title);
  const topicStr = topics.length > 0 ? ` Topics: ${topics.join(", ")}.` : "";
  const cveStr = cves.length > 0 ? ` CVE references: ${cves.join(", ")}.` : "";
  const productStr =
    products.length > 0 ? ` Affected products: ${products.join(", ")}.` : "";

  const summary =
    `NCSC-IE security advisory: ${adv.title}. ` +
    `Published ${adv.date}. Severity: ${severity}.${productStr}${cveStr}`;

  const fullText =
    `${adv.title}\n\n` +
    `Date: ${adv.date}\n` +
    `Severity: ${severity}\n` +
    `Source: NCSC Ireland (National Cyber Security Centre)\n` +
    `PDF: ${adv.pdfUrl}\n` +
    (products.length > 0 ? `Affected products: ${products.join(", ")}\n` : "") +
    (cves.length > 0 ? `CVE references: ${cves.join(", ")}\n` : "") +
    `${topicStr}\n\n` +
    `This advisory was published by NCSC-IE / CSIRT-IE. ` +
    `For full details including technical analysis, mitigations, and ` +
    `indicators of compromise, refer to the PDF document at ${adv.pdfUrl}.`;

  return {
    reference,
    title: adv.title,
    date: adv.date,
    severity,
    affected_products: products.length > 0 ? JSON.stringify(products) : null,
    summary: summary.slice(0, 2000),
    full_text: fullText.slice(0, 50_000),
    cve_references: cves.length > 0 ? JSON.stringify(cves) : null,
  };
}

// ---------------------------------------------------------------------------
// Database insert helpers
// ---------------------------------------------------------------------------

function createInsertStatements(db: Database.Database) {
  const insertGuidance = db.prepare(`
    INSERT OR REPLACE INTO guidance
      (reference, title, title_en, date, type, series, summary, full_text, topics, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAdvisory = db.prepare(`
    INSERT OR REPLACE INTO advisories
      (reference, title, date, severity, affected_products, summary, full_text, cve_references)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFramework = db.prepare(
    "INSERT OR REPLACE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)",
  );

  const updateFrameworkCount = db.prepare(
    "UPDATE frameworks SET document_count = (SELECT count(*) FROM guidance WHERE series = ?) WHERE id = ?",
  );

  return {
    insertGuidance,
    insertAdvisory,
    insertFramework,
    updateFrameworkCount,
  };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("NCSC-IE Ingestion Crawler");
  console.log("=========================");
  console.log(`  Database:       ${DB_PATH}`);
  console.log(
    `  Flags:          ${[force && "--force", dryRun && "--dry-run", resume && "--resume", advisoriesOnly && "--advisories-only", guidanceOnly && "--guidance-only"].filter(Boolean).join(", ") || "(none)"}`,
  );
  console.log(`  Rate limit:     ${RATE_LIMIT_MS}ms between requests`);
  console.log(`  Max retries:    ${MAX_RETRIES}`);
  console.log();

  const db = dryRun ? null : initDatabase();
  const stmts = db ? createInsertStatements(db) : null;
  const progress = loadProgress();

  let guidanceInserted = 0;
  let advisoriesInserted = 0;

  // -- Frameworks ------------------------------------------------------------

  if (!advisoriesOnly && stmts && db) {
    console.log("\n=== Inserting frameworks ===");
    const insertFrameworks = db.transaction(() => {
      for (const f of FRAMEWORKS) {
        stmts.insertFramework.run(
          f.id,
          f.name,
          f.name_en,
          f.description,
          f.document_count,
        );
      }
    });
    insertFrameworks();
    console.log(`  Inserted ${FRAMEWORKS.length} frameworks`);
  }

  // -- Guidance documents (RSS) -----------------------------------------------

  if (!advisoriesOnly) {
    const rssEntries = await fetchGuidanceFromRss();
    console.log(
      `\n=== Processing ${rssEntries.length} guidance documents ===`,
    );

    for (let i = 0; i < rssEntries.length; i++) {
      const entry = rssEntries[i]!;
      const row = guidanceRssToRow(entry);

      if (progress.completed_guidance_refs.includes(row.reference)) {
        console.log(
          `  [${i + 1}/${rssEntries.length}] ${row.reference} -- skipped (already completed)`,
        );
        continue;
      }

      console.log(
        `  [${i + 1}/${rssEntries.length}] ${row.reference}: ${row.title.slice(0, 60)}`,
      );

      if (dryRun) {
        console.log(
          `    [dry-run] Would insert: ${row.reference} (${row.full_text.length} chars, type=${row.type}, series=${row.series})`,
        );
      } else if (stmts) {
        stmts.insertGuidance.run(
          row.reference,
          row.title,
          row.title_en,
          row.date,
          row.type,
          row.series,
          row.summary,
          row.full_text,
          row.topics,
          row.status,
        );
        guidanceInserted++;
      }

      progress.completed_guidance_refs.push(row.reference);
      if ((i + 1) % 5 === 0) {
        saveProgress(progress);
      }
    }
    saveProgress(progress);
  }

  // -- NIS2 documents ---------------------------------------------------------

  if (!advisoriesOnly) {
    const nis2Entries = await fetchNis2Documents();
    console.log(`\n=== Processing ${nis2Entries.length} NIS2 documents ===`);

    for (let i = 0; i < nis2Entries.length; i++) {
      const entry = nis2Entries[i]!;
      const row = nis2EntryToRow(entry);

      if (progress.completed_nis2_refs.includes(row.reference)) {
        console.log(
          `  [${i + 1}/${nis2Entries.length}] ${row.reference} -- skipped (already completed)`,
        );
        continue;
      }

      console.log(
        `  [${i + 1}/${nis2Entries.length}] ${row.reference}: ${row.title.slice(0, 60)}`,
      );

      if (dryRun) {
        console.log(
          `    [dry-run] Would insert: ${row.reference} (type=${row.type}, series=${row.series})`,
        );
      } else if (stmts) {
        stmts.insertGuidance.run(
          row.reference,
          row.title,
          row.title_en,
          row.date,
          row.type,
          row.series,
          row.summary,
          row.full_text,
          row.topics,
          row.status,
        );
        guidanceInserted++;
      }

      progress.completed_nis2_refs.push(row.reference);
    }
    saveProgress(progress);
  }

  // -- Security advisories ----------------------------------------------------

  if (!guidanceOnly) {
    const advisoryEntries = await fetchAdvisoryListing();
    console.log(
      `\n=== Processing ${advisoryEntries.length} security advisories ===`,
    );

    for (let i = 0; i < advisoryEntries.length; i++) {
      const entry = advisoryEntries[i]!;
      const row = advisoryToRow(entry);

      if (progress.completed_advisory_refs.includes(row.reference)) {
        console.log(
          `  [${i + 1}/${advisoryEntries.length}] ${row.reference} -- skipped (already completed)`,
        );
        continue;
      }

      console.log(
        `  [${i + 1}/${advisoryEntries.length}] ${row.reference}: ${row.title.slice(0, 60)}`,
      );

      if (dryRun) {
        console.log(
          `    [dry-run] Would insert: ${row.reference} (severity=${row.severity}, CVEs=${row.cve_references ?? "none"})`,
        );
      } else if (stmts) {
        stmts.insertAdvisory.run(
          row.reference,
          row.title,
          row.date,
          row.severity,
          row.affected_products,
          row.summary,
          row.full_text,
          row.cve_references,
        );
        advisoriesInserted++;
      }

      progress.completed_advisory_refs.push(row.reference);
      if ((i + 1) % 20 === 0) {
        saveProgress(progress);
      }
    }
    saveProgress(progress);
  }

  // -- Update framework document counts ---------------------------------------

  if (stmts && db && !dryRun) {
    stmts.updateFrameworkCount.run("NCSC-IE", "ncsc-ie-guidance");
    stmts.updateFrameworkCount.run("NIS2-IE", "nis2-ie");

    // Advisory framework count comes from the advisories table
    const advCount = (
      db
        .prepare("SELECT count(*) as cnt FROM advisories")
        .get() as { cnt: number }
    ).cnt;
    db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?").run(
      advCount,
      "ncsc-ie-advisories",
    );

    console.log("\n  Updated framework document counts");
  }

  // -- Summary ----------------------------------------------------------------

  if (db && !dryRun) {
    const guidanceCount = (
      db
        .prepare("SELECT count(*) as cnt FROM guidance")
        .get() as { cnt: number }
    ).cnt;
    const advisoryCount = (
      db
        .prepare("SELECT count(*) as cnt FROM advisories")
        .get() as { cnt: number }
    ).cnt;
    const frameworkCount = (
      db
        .prepare("SELECT count(*) as cnt FROM frameworks")
        .get() as { cnt: number }
    ).cnt;
    const guidanceFtsCount = (
      db
        .prepare("SELECT count(*) as cnt FROM guidance_fts")
        .get() as { cnt: number }
    ).cnt;
    const advisoryFtsCount = (
      db
        .prepare("SELECT count(*) as cnt FROM advisories_fts")
        .get() as { cnt: number }
    ).cnt;

    console.log("\n=========================");
    console.log("Database summary:");
    console.log(`  Frameworks:      ${frameworkCount}`);
    console.log(
      `  Guidance docs:   ${guidanceCount} (FTS entries: ${guidanceFtsCount}) [+${guidanceInserted} this run]`,
    );
    console.log(
      `  Advisories:      ${advisoryCount} (FTS entries: ${advisoryFtsCount}) [+${advisoriesInserted} this run]`,
    );
    console.log(`\nDatabase ready at ${DB_PATH}`);

    db.close();
  } else if (dryRun) {
    console.log("\n=========================");
    console.log("[dry-run] No database changes made");
    console.log(
      `  Would have inserted ~${progress.completed_guidance_refs.length} guidance docs, ` +
        `${progress.completed_nis2_refs.length} NIS2 docs, ` +
        `and ${progress.completed_advisory_refs.length} advisories`,
    );
  }

  // Clean up progress file on successful full run (not resume)
  if (!resume && !dryRun && existsSync(PROGRESS_FILE)) {
    unlinkSync(PROGRESS_FILE);
    console.log("Cleaned up progress file");
  }
}

main().catch((err) => {
  console.error(
    `Fatal error: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
