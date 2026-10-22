# ADR-006: File and Document Storage

**Status:** Accepted  
**Date:** 2025

## Decision

S3-compatible object storage with two buckets:
- `isf-private-docs` — private, no public access, signed URLs only
- `isf-public-assets` — public read for CMS images and campaign banners

Local development uses MinIO (Docker Compose).

## Bucket Access Model

### Private Bucket (`isf-private-docs`)

Contains: applicant transcripts, student IDs, essays, supporting documents.

- **No public URLs are ever exposed.**
- Access is via short-lived presigned URLs (TTL: 5 minutes).
- Presigned URLs are generated server-side only after:
  1. Session verification (user must be authenticated)
  2. Ownership check (user owns the application) OR role check (REVIEWER/ADMIN)
  3. Audit log entry (who accessed which document, when)

### Public Bucket (`isf-public-assets`)

Contains: CMS article cover images, campaign banners, public media.

- Public read access.
- Write access: server-side only (admin/editor upload flow).
- No user-supplied files go to this bucket without admin moderation.

## Upload Flow (Private Documents)

```
Client (multipart form) → POST /api/v1/applications/:id/documents
  → Server validates session + ownership
  → multer (memory storage, ≤10 MB per file)
  → file-type package validates MIME type against magic bytes
  → Server-side size and type enforcement per document type
  → AWS SDK streams file to S3
  → S3 object KEY stored in application_documents table (not URL)
  → Temp buffer cleared immediately
```

## Signed URL Flow (Private Documents)

```
Client → GET /api/v1/applications/:id/documents/:docId
  → Server validates session + ownership/role
  → Audit log: "document_accessed", actor, document_id, timestamp
  → S3 getSignedUrl(key, { expiresIn: 300 })
  → Response: { signedUrl: "https://..." }
  → Client redirects to signed URL (direct S3/R2 download)
```

## Security Requirements

1. Never store raw S3 URLs in the database — store the object key only.
2. Never serve private documents as proxied streams (high bandwidth cost, DoS risk).
3. Validate MIME type using magic bytes (`file-type` package), not file extension.
4. Per-document-type size limits enforced server-side.
5. File name is sanitized before use; original name stored in metadata only.
6. S3 credentials are never exposed to the client.
7. IAM policy: least privilege — the app's S3 key can only access its own buckets.

## Allowed Document Types (Phase 2 definition)

| Document Type | MIME Type | Max Size |
|---------------|-----------|----------|
| transcript | application/pdf | 5 MB |
| student_id | image/jpeg, image/png, application/pdf | 2 MB |
| essay | application/pdf | 2 MB |
| achievement | image/jpeg, image/png, application/pdf | 5 MB |
| cover_image (CMS) | image/jpeg, image/webp, image/png | 3 MB |

## Local Development

MinIO is configured via Docker Compose:
- API endpoint: `http://localhost:9000`
- Web console: `http://localhost:9001`
- Credentials: configured via `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` in `.env`

## Implementation Phase

Phase 2 (private documents for scholarship applications).  
Phase 4 (public assets for CMS cover images).
