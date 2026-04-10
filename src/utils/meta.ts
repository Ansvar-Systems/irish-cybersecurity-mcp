/**
 * Response metadata helper for the NCSC-IE MCP server.
 *
 * Every tool response includes a _meta field so the platform's
 * entity linker knows which server and time produced the result.
 *
 * See: docs/guides/law-mcp-golden-standard.md Section 4.3
 */

export interface ResponseMeta {
  server: string;
  generated_at: string;
  data_source: string;
}

export function responseMeta(): ResponseMeta {
  return {
    server: "irish-cybersecurity-mcp",
    generated_at: new Date().toISOString(),
    data_source: "NCSC-IE (https://www.ncsc.gov.ie/)",
  };
}
