# Privacy Architecture — ISF Platform

**Status:** Design Document (must be implemented before Phase 2 data collection)  
**Date:** 2025

## Jurisdiction

The ISF platform collects personal data from Indonesian nationals.
All personal data handling must comply with **UU No. 27 Tahun 2022 tentang Perlindungan Data Pribadi (UU PDP)**.

This document must be reviewed by legal counsel before production launch.

---

## Data Classification

| Classification | Description | Examples |
|----------------|-------------|---------|
| **Highly Sensitive** | Data requiring strongest protection | Password hashes, financial account numbers, national ID numbers |
| **Sensitive Personal** | Personal data with significant privacy impact | Student ID, transcripts, GPA, phone number, home address, essay content |
| **Personal** | Identifying information | Name, email, university, faculty, year |
| **Operational** | Platform function data | Application status, review scores (without PII), audit log actions |
| **Public** | Intended for public display | Published articles, campaign descriptions |

---

## Data Minimization

Collect only the data required for the stated purpose.

**Do not collect:**
- National ID number (KTP) unless legally required and justified
- Parent/family income unless required for eligibility assessment (define explicitly)
- Social media profiles unless used in scoring criteria (define criteria first)
- Biometric data

**Collection must be justified per field** with a documented purpose before implementation.

---

## Purpose Limitation

Personal data collected for scholarship applications must not be used for:
- Marketing unrelated to ISF programs
- Sharing with third parties without explicit consent
- Profiling beyond scholarship eligibility assessment

---

## Retention Periods

| Data Category | Retention Period | Basis |
|---------------|-----------------|-------|
| Successful applicant profiles | Duration of scholarship + 5 years | Legal obligation |
| Rejected application data | 2 years after rejection | Dispute resolution |
| Audit logs | 7 years | Financial audit requirements |
| Payment records | 7 years | Tax and financial regulation |
| Session data | 30 days (sliding) | Technical requirement |
| Email verification tokens | 24 hours | Technical requirement |
| Password reset tokens | 1 hour | Security requirement |

**Automated deletion/anonymization jobs must be implemented** for data past its retention period.

---

## Access Control

- Applicant data is accessible only to the applicant and authorized staff (REVIEWER, ADMIN)
- Financial records: ADMIN only
- Audit logs: ADMIN only
- All document access (private bucket) is logged in audit_logs
- No bulk export of personal data without explicit ADMIN action and audit trail

---

## Sensitive Field Handling in Logs

The following fields must NEVER appear in application logs, error messages, or API responses:
- `password`, `passwordHash`
- `token`, `verificationToken`, `resetToken`
- `sessionId`, `sessionSecret`
- `bankAccountNumber`, `nationalId`
- `authorization` header value
- `cookie` header value

Pino logger is configured with field redaction for the most common paths.
Application code must not log objects that may contain the above fields.

---

## User Data Rights (UU PDP)

The platform must support the following user rights:

| Right | Implementation Phase |
|-------|---------------------|
| Right to access own data | Phase 2 (portal: view own profile and application) |
| Right to correction | Phase 2 (edit profile) |
| Right to deletion (where lawful) | Phase 3 (ADMIN soft-delete with retention check) |
| Right to data portability | Phase 3 (ADMIN-generated export) |
| Right to object to processing | Contact process (TBD) |
| Right to withdraw consent | Phase 2 (account deletion request) |

---

## Privacy Notice

A privacy notice must be displayed to users:
- At registration
- At application submission
- Before any data collection beyond basic account creation

The notice must describe:
- What data is collected
- Why it is collected
- How long it is retained
- Who it is shared with
- How to exercise data rights

**This must be written with legal input and published before Phase 2.**

---

## Document Access Logging

Every access to a private document (applicant transcript, student ID, essay) must be logged:
- Who accessed it (user ID, role)
- Which document (document ID, application ID)
- When (TIMESTAMPTZ)
- From where (IP address)

This log must be retained for the duration of the application data retention period.

---

## Anonymization Pattern

When user data reaches its retention period and must be deleted:
1. Null out personal fields: name, email, phone, address, national ID
2. Replace email with a non-reversible hash (for deduplication only)
3. Preserve: application IDs, status history, financial records (with anonymized beneficiary)
4. Log the anonymization event in audit_logs

---

## Open Questions

1. Is collection of national ID number (NIK) required for KTP-based identity verification?
2. What is the consent mechanism for data collected beyond the application form?
3. Does the platform need a Data Protection Officer (DPO)?
4. What third-party processors will receive personal data (SMTP provider, S3 provider)?

These questions must be resolved with legal counsel before Phase 2 collects applicant data.
