# Coverage

This document describes the corpus of data covered by the irish-cybersecurity-mcp server.

## Data Sources

| Source | URL | Status |
|--------|-----|--------|
| NCSC-IE Guidance RSS Feed | https://www.ncsc.gov.ie/guidance/guidance.rss | Live (ingest on demand) |
| NCSC-IE NIS2 Guidance | https://www.ncsc.gov.ie/nis2/ | Live (ingest on demand) |
| NCSC-IE Security Advisories | https://www.ncsc.gov.ie/news/ | Live (ingest on demand) |

## Corpus Description

### Guidance Documents

- **Source:** NCSC-IE official guidance RSS feed (`ncsc.gov.ie/guidance/guidance.rss`)
- **Approximate volume:** ~28 documents (as of last ingest)
- **Coverage:** Cybersecurity guidance for Irish organisations, NIS2-IE implementation guidance, critical infrastructure resilience recommendations
- **Types:** Technical guidelines, recommendations, standards

### NIS2-IE Guidance

- **Source:** NCSC-IE NIS2 guidance pages (`ncsc.gov.ie/nis2/`)
- **Coverage:** Irish implementation of EU NIS2 Directive requirements, incident reporting obligations, minimum security measures

### Security Advisories

- **Source:** NCSC-IE news/advisory listings (`ncsc.gov.ie/news/`)
- **Coverage:** Security advisories for Irish organisations, CVE-based alerts, ransomware warnings, critical infrastructure threat advisories
- **Severity levels:** Critical, High, Medium, Low

## Status

| Category | Live/Frozen | Last Ingest |
|----------|-------------|-------------|
| Guidance | Live | See `ie_cyber_check_data_freshness` |
| Advisories | Live | See `ie_cyber_check_data_freshness` |

**Live** means the corpus is updated by running `npm run ingest` or the `ingest.yml` workflow. There is no automatic real-time sync.

## What Is Not Covered

- NCSC-IE incident reports (not publicly available)
- Classified/restricted advisories
- Content behind authentication walls on ncsc.gov.ie
- Non-English language materials (NCSC-IE publishes in English)

## Ingest Script

```bash
npm run ingest               # Full crawl
npm run ingest -- --dry-run  # Preview without writing to DB
```

See `scripts/ingest-ncsc-ie.ts` for implementation details.

---

**Last Updated:** 2026-04-10
