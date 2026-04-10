#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "irish-cybersecurity-mcp";

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// --- Tool definitions (shared with index.ts) ---------------------------------

const TOOLS = [
  {
    name: "ie_cyber_search_guidance",
    description:
      "Full-text search across NCSC-IE guidance documents and technical reports. Covers cybersecurity guidance, NIS2-IE guidance, and critical infrastructure recommendations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'ransomware', 'cloud security', 'NIS2 compliance')" },
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
          description: "Filter by document status. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
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
        reference: { type: "string", description: "NCSC-IE document reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "ie_cyber_search_advisories",
    description:
      "Search NCSC-IE security advisories and alerts. Returns advisories with severity, affected products, and CVE references.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'ransomware', 'critical vulnerability')" },
        severity: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          description: "Filter by severity level. Optional.",
        },
        limit: { type: "number", description: "Max results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "ie_cyber_get_advisory",
    description: "Get a specific NCSC-IE security advisory by reference (e.g., 'NCSC-IE-2024-ADV-001').",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "NCSC-IE advisory reference" },
      },
      required: ["reference"],
    },
  },
  {
    name: "ie_cyber_list_frameworks",
    description:
      "List all NCSC-IE frameworks and standard series covered in this MCP, including NCSC-IE Guidance series, NIS2-IE guidance, and Critical Infrastructure frameworks.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ie_cyber_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ie_cyber_list_sources",
    description:
      "List official NCSC-IE data sources ingested by this MCP, including guidance RSS feed and advisory listings. Use to verify data provenance.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "ie_cyber_check_data_freshness",
    description:
      "Check the freshness of NCSC-IE data in this MCP. Returns the latest guidance and advisory dates from the database and document counts.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// --- Zod schemas -------------------------------------------------------------

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

// --- MCP server factory ------------------------------------------------------

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      const payload =
        typeof data === "object" && data !== null
          ? { ...(data as object), _meta: responseMeta() }
          : data;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
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

  return server;
}

// --- HTTP server -------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
