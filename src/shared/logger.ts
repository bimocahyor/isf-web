/**
 * Pino logger instance.
 *
 * Sensitive fields (password, token, secret, authorization, cookie) are
 * redacted from log output to prevent accidental credential leakage.
 */

import pino, { type LoggerOptions } from 'pino';
import { env } from '../config/index.js';

const redactPaths = [
  'password',
  'newPassword',
  'passwordHash',
  'token',
  'rawToken',
  'tokenHash',
  'secret',
  'sessionSecret',
  'csrfToken',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.rawToken',
  '*.tokenHash',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-csrf-token"]',
];

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
};

if (env.NODE_ENV !== 'production') {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  };
}

export const logger = pino(options);
