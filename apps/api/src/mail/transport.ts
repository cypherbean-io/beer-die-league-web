import nodemailer from 'nodemailer';
import type { MailTransport } from './outbox.ts';

export function createSmtpTransport(smtpUrl: string): MailTransport {
  return nodemailer.createTransport(smtpUrl);
}
