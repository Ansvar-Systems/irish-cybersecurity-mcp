/**
 * Seed the NCSC-IE database with sample guidance documents, advisories, and
 * frameworks for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["NCSC_IE_DB_PATH"] ?? "data/ncsc-ie.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); }
if (force && existsSync(DB_PATH)) { unlinkSync(DB_PATH); console.log(`Deleted existing database at ${DB_PATH}`); }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);
console.log(`Database initialised at ${DB_PATH}`);

interface FrameworkRow { id: string; name: string; name_en: string; description: string; document_count: number; }

const frameworks: FrameworkRow[] = [
  { id: "ncsc-ie-guidance", name: "NCSC-IE Guidance Series", name_en: "NCSC Ireland Guidance Series",
    description: "Official cybersecurity guidance from the National Cyber Security Centre Ireland. Covers network security, cloud, ransomware, incident response, and critical infrastructure under NIS2.",
    document_count: 5 },
  { id: "nis2-ie", name: "NIS2 Implementation — Ireland", name_en: "NIS2 Directive Implementation in Ireland",
    description: "Guidance on Directive (EU) 2022/2555 (NIS2) as transposed into Irish law. Covers essential and important entity obligations, incident reporting, and supply chain security.",
    document_count: 2 },
  { id: "critical-infrastructure", name: "Critical Infrastructure Protection", name_en: "Critical Infrastructure Cybersecurity",
    description: "NCSC-IE guidance for operators of critical infrastructure in energy, water, transport, financial services, and digital infrastructure sectors.",
    document_count: 2 },
];

const insertFramework = db.prepare("INSERT OR IGNORE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)");
for (const f of frameworks) { insertFramework.run(f.id, f.name, f.name_en, f.description, f.document_count); }
console.log(`Inserted ${frameworks.length} frameworks`);

interface GuidanceRow { reference: string; title: string; title_en: string; date: string; type: string; series: string; summary: string; full_text: string; topics: string; status: string; }

const guidance: GuidanceRow[] = [
  {
    reference: "NCSC-IE-2023-001", title: "Ransomware: Guidance for Organisations",
    title_en: "Ransomware: Guidance for Organisations", date: "2023-03-15",
    type: "guidance", series: "NCSC-IE",
    summary: "Comprehensive guidance on ransomware threats, prevention measures, and incident response for Irish organisations. Covers backup strategies, network segmentation, employee awareness, and steps to take if attacked.",
    full_text: "Ransomware remains one of the most significant cybersecurity threats facing Irish organisations. Prevention: Organisations should maintain offline and tested backups, patch systems promptly, implement multi-factor authentication across all systems, and segment networks to limit lateral movement. Employee awareness training is essential — most ransomware attacks begin with phishing. Detection: Deploy endpoint detection and response (EDR) tools and maintain centralised logging. Anomalous encryption activity and unusual network traffic are indicators of compromise. Response: If ransomware is detected, isolate affected systems immediately. Do not pay the ransom — payment does not guarantee data recovery and funds criminal activity. Notify NCSC-IE and report to An Garda Siochana. Preserve forensic evidence before remediation. Recovery: Restore from clean backups. Verify backup integrity before restoration. Irish organisations have NIS2 obligations to report significant incidents to NCSC-IE within 24 hours.",
    topics: JSON.stringify(["ransomware", "incident-response", "backup", "NIS2"]), status: "current",
  },
  {
    reference: "NCSC-IE-2023-002", title: "Cloud Security: Guidance for Irish Organisations",
    title_en: "Cloud Security: Guidance for Irish Organisations", date: "2023-06-20",
    type: "guidance", series: "NCSC-IE",
    summary: "Guidance on securing cloud environments for Irish organisations, covering shared responsibility models, identity and access management, data residency under GDPR, and security monitoring.",
    full_text: "Cloud adoption by Irish organisations has accelerated. Shared Responsibility Model: Security responsibilities are shared between the cloud provider and the customer. Identity and Access Management: Implement least-privilege access, enforce multi-factor authentication for all cloud console access, and regularly review access rights. Data Residency and GDPR: Irish organisations must consider GDPR requirements when storing data outside the EEA. Standard Contractual Clauses or adequacy decisions must be in place. Security Monitoring: Enable cloud provider logging. Integrate logs with a centralised SIEM. Monitor for privileged account access and configuration changes. Misconfiguration: Implement Cloud Security Posture Management (CSPM) tools. Ensure storage buckets are not publicly accessible unless intentional. NIS2 Obligations: Cloud services used by essential and important entities must meet NIS2 security requirements including vendor risk assessments.",
    topics: JSON.stringify(["cloud", "GDPR", "IAM", "NIS2", "monitoring"]), status: "current",
  },
  {
    reference: "NCSC-IE-2023-003", title: "NIS2 Directive: Guide for Essential and Important Entities in Ireland",
    title_en: "NIS2 Directive: Guide for Essential and Important Entities in Ireland", date: "2023-11-01",
    type: "standard", series: "NIS2-IE",
    summary: "Guidance for organisations classified as essential or important entities under the NIS2 Directive as transposed into Irish law. Covers registration, security measures, incident reporting, and supply chain obligations.",
    full_text: "The NIS2 Directive (Directive (EU) 2022/2555) was transposed into Irish law with effect from October 2024. Essential entities include operators in energy, transport, banking, financial market infrastructure, health, drinking water, wastewater, digital infrastructure, ICT service management, public administration, and space. Important entities include postal services, waste management, chemicals, food, manufacturing, and digital providers. Security Measures: All covered entities must implement risk analysis policies, incident handling, business continuity including backup management, supply chain security, network and system security, cybersecurity training, cryptography where appropriate, human resources security, access control policies, and multi-factor authentication. Incident Reporting: Essential and important entities must notify NCSC-IE within 24 hours (early warning), 72 hours (incident notification), and one month (final report). A significant incident is one with a major impact on service provision. Penalties: NCSC-IE can impose fines up to EUR 10 million or 2% of worldwide turnover for essential entities, and EUR 7 million or 1.4% for important entities.",
    topics: JSON.stringify(["NIS2", "compliance", "incident-reporting", "essential-entities"]), status: "current",
  },
  {
    reference: "NCSC-IE-2024-001", title: "Supply Chain Cybersecurity: Guidance for Irish Organisations",
    title_en: "Supply Chain Cybersecurity: Guidance for Irish Organisations", date: "2024-02-14",
    type: "guidance", series: "NCSC-IE",
    summary: "Guidance on managing cybersecurity risks in supply chains, including ICT supplier risk assessment, contractual security requirements, and third-party monitoring. Aligned with NIS2 supply chain security obligations.",
    full_text: "Supply chain attacks have increased significantly. Risk Assessment: Categorise suppliers by criticality. For critical ICT suppliers, conduct due diligence including security questionnaires, audits, and review of certifications (ISO 27001, SOC 2). Contractual Requirements: Include cybersecurity requirements in supplier contracts: right to audit, incident notification obligations aligned with NIS2 reporting timelines, minimum security standards, data handling controls, and vulnerability disclosure requirements. Monitoring: Continuously monitor critical suppliers. Review supplier security posture annually. Software Bills of Materials (SBOM): Request SBOMs from software suppliers to understand component dependencies. NIS2 Requirement: Article 21 of the NIS2 Directive mandates supply chain security for essential and important entities. NCSC-IE will assess compliance with this requirement as part of its supervisory activities.",
    topics: JSON.stringify(["supply-chain", "third-party", "NIS2", "vendor-risk"]), status: "current",
  },
  {
    reference: "NCSC-IE-2024-002", title: "Critical Infrastructure Cyber Resilience Framework",
    title_en: "Critical Infrastructure Cyber Resilience Framework", date: "2024-05-30",
    type: "standard", series: "NCSC-IE",
    summary: "Framework for cybersecurity resilience in Irish critical infrastructure sectors. Provides tiered security controls mapped to NIST CSF 2.0, aligned with NIS2, for operators in energy, water, transport, and healthcare.",
    full_text: "Critical infrastructure operators in Ireland face escalating cyber threats. Identify: Develop an up-to-date asset inventory of OT/IT systems. Conduct regular risk assessments. Document dependencies between systems. Protect: Implement network segmentation between IT and OT environments. Apply least-privilege access. Harden remote access with MFA. Keep systems patched; for legacy OT systems, implement compensating controls. Detect: Deploy security monitoring across IT and OT environments. Establish a Security Operations Centre (SOC) or engage a managed security service provider. Implement intrusion detection at network boundaries. Respond: Maintain tested incident response and business continuity plans. Conduct tabletop exercises annually. Pre-establish relationships with NCSC-IE and An Garda Siochana. Report significant incidents per NIS2 timelines. Recover: Maintain resilient and tested backups for all critical systems. Establish recovery time objectives (RTO) and recovery point objectives (RPO). Test recovery procedures annually.",
    topics: JSON.stringify(["critical-infrastructure", "OT", "resilience", "NIS2", "NIST-CSF"]), status: "current",
  },
];

const insertGuidance = db.prepare("INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const insertGuidanceAll = db.transaction(() => { for (const g of guidance) { insertGuidance.run(g.reference, g.title, g.title_en, g.date, g.type, g.series, g.summary, g.full_text, g.topics, g.status); } });
insertGuidanceAll();
console.log(`Inserted ${guidance.length} guidance documents`);

interface AdvisoryRow { reference: string; title: string; date: string; severity: string; affected_products: string; summary: string; full_text: string; cve_references: string; }

const advisories: AdvisoryRow[] = [
  {
    reference: "NCSC-IE-ADV-2024-001", title: "Critical Vulnerability in Ivanti Connect Secure and Policy Secure",
    date: "2024-01-11", severity: "critical",
    affected_products: JSON.stringify(["Ivanti Connect Secure", "Ivanti Policy Secure"]),
    summary: "NCSC-IE warns of active exploitation of critical vulnerabilities in Ivanti Connect Secure and Policy Secure VPN appliances. CVE-2023-46805 (authentication bypass) and CVE-2024-21887 (command injection) are being chained by threat actors. Irish organisations should apply mitigations immediately.",
    full_text: "NCSC-IE is aware of active exploitation of two critical vulnerabilities in Ivanti Connect Secure and Ivanti Policy Secure gateways. CVE-2023-46805 (CVSS 8.2) is an authentication bypass vulnerability. CVE-2024-21887 (CVSS 9.1) is a command injection vulnerability. These vulnerabilities are being chained by threat actors to achieve unauthenticated remote code execution. Immediate actions: (1) Apply Ivanti mitigations published 10 January 2024. (2) Run Ivanti Integrity Checker Tool to detect compromise. (3) If compromise is detected, follow Ivanti factory reset instructions. (4) Monitor for indicators of compromise including web shell deployment and credential harvesting. Reporting: Report suspected compromises to cert@ncsc.gov.ie.",
    cve_references: JSON.stringify(["CVE-2023-46805", "CVE-2024-21887"]),
  },
  {
    reference: "NCSC-IE-ADV-2024-002", title: "Irish Organisations Targeted by ALPHV/BlackCat Ransomware Group",
    date: "2024-03-08", severity: "high",
    affected_products: JSON.stringify(["Multiple sectors", "Healthcare", "Financial services"]),
    summary: "NCSC-IE has observed ALPHV/BlackCat ransomware group targeting Irish organisations in healthcare and financial services. The group exploits unpatched vulnerabilities and uses valid credentials obtained through phishing.",
    full_text: "NCSC-IE has received credible threat intelligence indicating that the ALPHV/BlackCat ransomware group is actively targeting Irish organisations, with a particular focus on healthcare and financial services. ALPHV/BlackCat is a ransomware-as-a-service (RaaS) group. Attack vectors: (1) Exploitation of unpatched remote access software. (2) Credential stuffing using compromised credentials from third-party breaches. (3) Spear phishing targeting finance and IT staff. (4) Supply chain compromise through managed service providers. Recommended actions: Ensure VPN and remote access software is fully patched. Enable MFA on all external-facing systems. Review and restrict RDP access. Brief staff on spear phishing. Test backups and ensure offline copies are available. Report related incidents to NCSC-IE.",
    cve_references: JSON.stringify([]),
  },
  {
    reference: "NCSC-IE-ADV-2024-003", title: "Microsoft Exchange Server: Critical Remote Code Execution Vulnerability",
    date: "2024-04-22", severity: "critical",
    affected_products: JSON.stringify(["Microsoft Exchange Server 2016", "Microsoft Exchange Server 2019"]),
    summary: "NCSC-IE advises immediate patching of CVE-2024-21410 in Microsoft Exchange Server. The vulnerability allows unauthenticated NTLM relay attacks. Exchange Online is not affected.",
    full_text: "A critical vulnerability (CVE-2024-21410, CVSS 9.8) has been identified in Microsoft Exchange Server. The vulnerability allows an unauthenticated attacker to relay NTLM credentials and authenticate as that user. Affected versions: Microsoft Exchange Server 2016 (CU22 before KB5035320) and Exchange Server 2019 (CU13 before KB5035319). Exchange Online (Microsoft 365) is not affected. Immediate actions: (1) Apply the February 2024 Cumulative Update immediately. (2) Where immediate patching is not possible, temporarily disable NTLM authentication on Exchange. (3) Review IIS logs for exploitation attempts. (4) Organisations running Exchange Server 2013 (end of life April 2023) should migrate immediately.",
    cve_references: JSON.stringify(["CVE-2024-21410"]),
  },
];

const insertAdvisory = db.prepare("INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertAdvisoriesAll = db.transaction(() => { for (const a of advisories) { insertAdvisory.run(a.reference, a.title, a.date, a.severity, a.affected_products, a.summary, a.full_text, a.cve_references); } });
insertAdvisoriesAll();
console.log(`Inserted ${advisories.length} advisories`);

const guidanceCount = (db.prepare("SELECT count(*) as cnt FROM guidance").get() as { cnt: number }).cnt;
const advisoryCount = (db.prepare("SELECT count(*) as cnt FROM advisories").get() as { cnt: number }).cnt;
const frameworkCount = (db.prepare("SELECT count(*) as cnt FROM frameworks").get() as { cnt: number }).cnt;
console.log("\nDatabase summary:");
console.log(`  Frameworks:  ${frameworkCount}`);
console.log(`  Guidance:    ${guidanceCount}`);
console.log(`  Advisories:  ${advisoryCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);
db.close();
