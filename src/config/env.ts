/**
 * Environment configuration with Zod validation.
 *
 * All environment variables are validated at application startup.
 * The application will refuse to start if required variables are missing or invalid.
 * This prevents silent misconfiguration in production.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  // Database
  DATABASE_URL: z.string().refine(
    (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
    { message: 'DATABASE_URL must start with postgresql:// or postgres://' }
  ),

  // Session
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  // SMTP
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().default('noreply@intelegensia.id'),

  // Storage
  // Local dev defaults match docker-compose.yml MinIO configuration.
  // These values are development-only and must be overridden via .env in production.
  STORAGE_ENDPOINT: z.string().min(1).default('http://localhost:9000'),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).default('isf_minio_user'),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).default('isf_minio_password'), // dev-only default
  STORAGE_BUCKET_PRIVATE: z.string().min(1).default('isf-private-docs'),
  STORAGE_BUCKET_PUBLIC: z.string().min(1).default('isf-public-assets'),

  // Payment (placeholders — not implemented in Phase 0)
  PAYMENT_PROVIDER: z.enum(['mock', 'midtrans', 'xendit']).default('mock'),
  PAYMENT_MIDTRANS_SERVER_KEY: z.string().optional(),
  PAYMENT_MIDTRANS_CLIENT_KEY: z.string().optional(),
  PAYMENT_XENDIT_SECRET_KEY: z.string().optional(),
  PAYMENT_XENDIT_WEBHOOK_TOKEN: z.string().optional(),

  // Logging
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Validate and export
// ---------------------------------------------------------------------------

/**
 * Parse and validate environment variables.
 * Throws with a human-readable message if validation fails.
 */
export function validateEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');

    throw new Error(
      `❌  Environment configuration invalid — application cannot start.\n` +
        `Missing or invalid variables:\n${formatted}\n\n` +
        `Check .env.example for required variables.`,
    );
  }

  return result.data;
}

// Singleton: validated once at startup, imported everywhere else.
export const env = validateEnv();
