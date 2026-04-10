# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

We support only the latest minor version. Please upgrade to receive security patches.

## Security Scanning

This project uses automated security scanning in CI/CD:

### Dependency Vulnerabilities

- **Dependabot**: Automated weekly dependency updates for npm packages and GitHub Actions (`.github/dependabot.yml`)
- **npm audit**: Run manually before releases — `npm audit` to check for known vulnerabilities

### Container Security

- **GHCR Build**: Docker image is built and pushed to GitHub Container Registry on each push to `main`/`dev` (`.github/workflows/ghcr-build.yml`)
- **Secret Detection**: Gitleaks configured via `.gitleaks.toml` for secret scanning in git history

### Data Freshness

- **Weekly freshness check**: `.github/workflows/check-freshness.yml` runs NCSC-IE ingest in dry-run mode weekly to detect new content
- **Monthly ingest**: `.github/workflows/ingest.yml` refreshes the NCSC-IE database and uploads as a GitHub Release asset

### What We Scan For

- Known CVEs in dependencies (via Dependabot + npm audit)
- Hardcoded secrets and credentials (via Gitleaks)
- Container image vulnerabilities (via GHCR build pipeline)

## Reporting a Vulnerability

If you discover a security vulnerability:

1. **Do NOT open a public GitHub issue**
2. Email: hello@ansvar.ai
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if you have one)

We will respond within 48 hours and provide a timeline for a fix.

## Security Best Practices

This project follows security best practices:

- All database queries use prepared statements (no SQL injection)
- Input validation on all user-provided parameters
- Read-only database access (no write operations at runtime)
- No execution of user-provided code
- Automated dependency updates via Dependabot

## Database Security

### Regulatory Database (SQLite)

The regulatory database is:
- Pre-built and version-controlled (tamper evident)
- Opened in read-only mode at runtime (no write risk)
- Source data from official regulatory authorities (auditable)
- Ingestion scripts require manual or scheduled execution (no auto-download at runtime)

## Third-Party Dependencies

We minimize dependencies and regularly audit:
- Core runtime: Node.js, TypeScript
- MCP SDK: Official Anthropic package (`@modelcontextprotocol/sdk`)
- Database: `better-sqlite3`
- Validation: `zod`
- No unnecessary dependencies

All dependencies are tracked via `package-lock.json`.

---

**Last Updated**: 2026-04-10
