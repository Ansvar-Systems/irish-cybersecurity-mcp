# Tools Reference

This document lists all MCP tools exposed by the `irish-cybersecurity-mcp` server.

## Tool Prefix

All tools use the prefix `ie_cyber_` to namespace them within the Ansvar fleet.

## Tools

| Tool | Description | Required Args | Optional Args |
|------|-------------|---------------|---------------|
| `ie_cyber_search_guidance` | Full-text search across NCSC-IE guidance documents | `query` | `type`, `series`, `status`, `limit` |
| `ie_cyber_get_guidance` | Retrieve a specific guidance document by reference | `reference` | — |
| `ie_cyber_search_advisories` | Search NCSC-IE security advisories | `query` | `severity`, `limit` |
| `ie_cyber_get_advisory` | Retrieve a specific advisory by reference | `reference` | — |
| `ie_cyber_list_frameworks` | List all NCSC-IE frameworks in the database | — | — |
| `ie_cyber_about` | Return server metadata, version, coverage, and tool list | — | — |
| `ie_cyber_list_sources` | List official data sources ingested by this MCP | — | — |
| `ie_cyber_check_data_freshness` | Check latest guidance/advisory dates and document counts | — | — |

---

## Detailed Tool Descriptions

### `ie_cyber_search_guidance`

Full-text search across NCSC-IE guidance documents and technical reports.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `"ransomware"`, `"cloud security"`, `"NIS2 compliance"`) |
| `type` | enum | No | Filter by document type: `technical_guideline`, `it_grundschutz`, `standard`, `recommendation` |
| `series` | enum | No | Filter by NCSC-IE series: `NCSC-IE`, `NIS2-IE`, `Guidance` |
| `status` | enum | No | Filter by status: `current`, `superseded`, `draft` |
| `limit` | number | No | Max results (default: 20, max: 100) |

**Example call:**
```json
{
  "tool": "ie_cyber_search_guidance",
  "arguments": { "query": "ransomware incident response", "series": "NCSC-IE", "limit": 5 }
}
```

---

### `ie_cyber_get_guidance`

Retrieve a specific NCSC-IE guidance document by its reference identifier.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `reference` | string | Yes | NCSC-IE document reference (e.g., `"NCSC-IE-2024-001"`, `"NIS2-IE-001"`) |

**Example call:**
```json
{
  "tool": "ie_cyber_get_guidance",
  "arguments": { "reference": "NCSC-IE-2024-001" }
}
```

---

### `ie_cyber_search_advisories`

Search NCSC-IE security advisories. Returns advisories with severity rating, affected products, and CVE references where available.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `"Ivanti"`, `"ransomware"`, `"VPN vulnerability"`) |
| `severity` | enum | No | Filter by severity: `critical`, `high`, `medium`, `low` |
| `limit` | number | No | Max results (default: 20, max: 100) |

**Example call:**
```json
{
  "tool": "ie_cyber_search_advisories",
  "arguments": { "query": "critical vulnerability", "severity": "critical", "limit": 10 }
}
```

---

### `ie_cyber_get_advisory`

Retrieve a specific NCSC-IE security advisory by its reference identifier.

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `reference` | string | Yes | NCSC-IE advisory reference (e.g., `"NCSC-IE-2024-ADV-001"`) |

**Example call:**
```json
{
  "tool": "ie_cyber_get_advisory",
  "arguments": { "reference": "NCSC-IE-2024-ADV-001" }
}
```

---

### `ie_cyber_list_frameworks`

List all NCSC-IE frameworks and standard series available in the database.

**Arguments:** None

**Example call:**
```json
{
  "tool": "ie_cyber_list_frameworks",
  "arguments": {}
}
```

---

### `ie_cyber_about`

Return metadata about this MCP server: version, data source, coverage summary, and full tool list.

**Arguments:** None

**Example call:**
```json
{
  "tool": "ie_cyber_about",
  "arguments": {}
}
```

---

### `ie_cyber_list_sources`

List the official NCSC-IE data sources ingested by this MCP, including their URLs and descriptions. Use this to verify data provenance before citing results.

**Arguments:** None

**Example call:**
```json
{
  "tool": "ie_cyber_list_sources",
  "arguments": {}
}
```

---

### `ie_cyber_check_data_freshness`

Check the freshness of NCSC-IE data in this MCP. Returns the latest guidance and advisory publication dates from the database, plus document counts.

**Arguments:** None

**Example call:**
```json
{
  "tool": "ie_cyber_check_data_freshness",
  "arguments": {}
}
```

---

## Response Shape

All tools return responses with:

- `_meta` — server metadata (`server`, `generated_at`, `data_source`)
- `_citation` — deterministic citation metadata on all document/advisory responses (enables the platform entity linker)
- `_error_type` — on error responses (`not_found`, `tool_error`, `unknown_tool`, `execution_error`)

---

**Last Updated:** 2026-04-10
