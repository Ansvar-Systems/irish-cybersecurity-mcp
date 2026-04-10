#!/usr/bin/env node

/**
 * NCSC-IE Cybersecurity MCP — stdio entry point.
 *
 * Provides MCP tools for querying NCSC-IE (National Cyber Security Centre
 * Ireland) guidance documents, security advisories, and frameworks.
 *
 * Tool prefix: ie_cyber_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchGuidance,
  getGuidance,
  searchAdvisories,
  getAdvisory,
  listFrameworks,
  getDataFreshness,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";
import { responseMeta } from "./utils/meta.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "irish-cybersecurity-mcp";

// --- Tool definitions ---------------------------------------------------------

const TOOLS = [
  {
    name: "ie_cyber_search_guidance",
    description:
      "Full-text search across NCSC-IE guidance documents and technical reports. Covers cybersecurity guidance, NIS2-IE guidance, and critical infrastructure recommendations. Returns matching documents with reference, title, series, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'ransomware', 'cloud security', 'NIS2 compliance')",
        },
        type: {
          type: "string",
          enum: ["technical_guideline", "it_grundschutz", "standard", "recommendation"],
          description: "Filter by document type. Optional.",
        },
        series: {
          type: "string",
          enum: ["NCSC-IE", "NIS2-IE", "Guidance"],
          description: "Filter by NCSC-IE series. Optional.",
        },
        status: {
          type: "string",
          enum: ["current", "superseded", "draft"],
          description: "Filter by document status. Defaults to returning all statuses.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_cyber_get_guidance",
    description:
      "Get a specific NCSC-IE guidance document by reference (e.g., 'NCSC-IE-2024-001', 'NIS2-IE-001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "NCSC-IE document reference",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "ie_cyber_search_advisories",
    description:
      "Search NCSC-IE security advisories and alerts. Returns advisories with severity, affected products, and CVE references where available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'ransomware', 'critical vulnerability', 'VPN')",
        },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity level. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_cyber_get_advisory",
    description:
      "Get a specific NCSC-IE security advisory by reference (e.g., 'NCSC-IE-2024-ADV-001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "NCSC-IE advisory reference",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "ie_cyber_list_frameworks",
    description:
      "List all NCSC-IE frameworks and standard series covered in this MCP, including NCSC-IE Guidance series, NIS2-IE guidance, and Critical Infrastructure frameworks.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ie_cyber_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ie_cyber_list_sources",
    description:
      "List official NCSC-IE data sources ingested by this MCP, including guidance RSS feed and advisory listings. Use to verify data provenance.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "ie_cyber_check_data_freshness",
    description:
      "Check the freshness of NCSC-IE data in this MCP. Returns the latest guidance and advisory dates from the database and document counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// --- Zod schemas for argument validation --------------------------------------

const SearchGuidanceArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["technical_guideline", "it_grundschutz", "standard", "recommendation"]).optional(),
  series: z.enum(["NCSC-IE", "NIS2-IE", "Guidance"]).optional(),
  status: z.enum(["current", "superseded", "draft"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetGuidanceArgs = z.object({
  reference: z.string().min(1),
});

const SearchAdvisoriesArgs = z.object({
  query: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetAdvisoryArgs = z.object({
  reference: z.string().min(1),
});

// --- Helper ------------------------------------------------------------------

function textContent(data: unknown) {
  const payload =
    typeof data === "object" && data !== null
      ? { ...(data as object), _meta: responseMeta() }
      : data;
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string, errorType = "tool_error") {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { error: message, _error_type: errorType, _meta: responseMeta() },
          null,
          2,
        ),
      },
    ],
    isError: true as const,
  };
}

// --- Server setup ------------------------------------------------------------

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "ie_cyber_search_guidance": {
        const parsed = SearchGuidanceArgs.parse(args);
        const results = searchGuidance({
          query: parsed.query,
          type: parsed.type,
          series: parsed.series,
          status: parsed.status,
          limit: parsed.limit,
        });
        const resultsWithCitation = results.map((r) => ({
          ...r,
          _citation: buildCitation(
            r.reference,
            r.title,
            "ie_cyber_get_guidance",
            { reference: r.reference },
          ),
        }));
        return textContent({ results: resultsWithCitation, count: results.length });
      }

      case "ie_cyber_get_guidance": {
        const parsed = GetGuidanceArgs.parse(args);
        const doc = getGuidance(parsed.reference);
        if (!doc) {
          return errorContent(`Guidance document not found: ${parsed.reference}`, "not_found");
        }
        const d = doc as Record<string, unknown>;
        return textContent({
          ...doc,
          _citation: buildCitation(
            String(d.reference ?? parsed.reference),
            String(d.title ?? d.reference ?? parsed.reference),
            "ie_cyber_get_guidance",
            { reference: parsed.reference },
          ),
        });
      }

      case "ie_cyber_search_advisories": {
        const parsed = SearchAdvisoriesArgs.parse(args);
        const results = searchAdvisories({
          query: parsed.query,
          severity: parsed.severity,
          limit: parsed.limit,
        });
        const resultsWithCitation = results.map((r) => ({
          ...r,
          _citation: buildCitation(
            r.reference,
            r.title,
            "ie_cyber_get_advisory",
            { reference: r.reference },
          ),
        }));
        return textContent({ results: resultsWithCitation, count: results.length });
      }

      case "ie_cyber_get_advisory": {
        const parsed = GetAdvisoryArgs.parse(args);
        const advisory = getAdvisory(parsed.reference);
        if (!advisory) {
          return errorContent(`Advisory not found: ${parsed.reference}`, "not_found");
        }
        const adv = advisory as Record<string, unknown>;
        return textContent({
          ...advisory,
          _citation: buildCitation(
            String(adv.reference ?? parsed.reference),
            String(adv.title ?? adv.reference ?? parsed.reference),
            "ie_cyber_get_advisory",
            { reference: parsed.reference },
          ),
        });
      }

      case "ie_cyber_list_frameworks": {
        const frameworks = listFrameworks();
        return textContent({ frameworks, count: frameworks.length });
      }

      case "ie_cyber_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "NCSC-IE (National Cyber Security Centre Ireland) MCP server. Provides access to NCSC-IE cybersecurity guidance documents, NIS2-IE guidance, security advisories, and critical infrastructure frameworks.",
          data_source: "NCSC-IE (https://www.ncsc.gov.ie/)",
          coverage: {
            guidance: "NCSC-IE cybersecurity guidance documents and technical reports (~28 documents via RSS feed)",
            advisories: "NCSC-IE security advisories and alerts",
            frameworks: "NCSC-IE Guidance series, NIS2-IE, Critical Infrastructure frameworks",
          },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "ie_cyber_list_sources": {
        return textContent({
          sources: [
            {
              name: "NCSC-IE Guidance RSS Feed",
              url: "https://www.ncsc.gov.ie/guidance/guidance.rss",
              description: "Official RSS feed of NCSC-IE cybersecurity guidance documents",
            },
            {
              name: "NCSC-IE NIS2 Guidance",
              url: "https://www.ncsc.gov.ie/nis2/",
              description: "NCSC-IE guidance on NIS2 Directive implementation in Ireland",
            },
            {
              name: "NCSC-IE Security Advisories",
              url: "https://www.ncsc.gov.ie/news/",
              description: "NCSC-IE security advisories, alerts, and news",
            },
          ],
        });
      }

      case "ie_cyber_check_data_freshness": {
        const freshness = getDataFreshness();
        return textContent(freshness);
      }

      default:
        return errorContent(`Unknown tool: ${name}`, "unknown_tool");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`, "execution_error");
  }
});

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
