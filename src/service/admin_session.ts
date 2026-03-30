import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Account2ServiceConfig } from './config';

const activeSessions = new Map<string, number>();

function parseCookies(header: string | undefined): Record<string, string> {
    if (!header) {
        return {};
    }
    return header.split(';').reduce<Record<string, string>>((cookies, part) => {
        const [rawName, ...rawValue] = part.trim().split('=');
        if (!rawName) {
            return cookies;
        }
        cookies[rawName] = decodeURIComponent(rawValue.join('=') || '');
        return cookies;
    }, {});
}

function safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, expiresAt] of activeSessions.entries()) {
        if (expiresAt <= now) {
            activeSessions.delete(token);
        }
    }
}

function getSessionToken(req: Request, config: Account2ServiceConfig): string | undefined {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[config.adminSessionCookieName];
}

export function validateAdminCredentials(
    username: string,
    password: string,
    config: Account2ServiceConfig,
): boolean {
    return safeEqual(username, config.admin.username) && safeEqual(password, config.admin.password);
}

export function isAdminAuthenticated(req: Request, config: Account2ServiceConfig): boolean {
    cleanupExpiredSessions();
    const token = getSessionToken(req, config);
    if (!token) {
        return false;
    }
    const expiresAt = activeSessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
        activeSessions.delete(token);
        return false;
    }
    return true;
}

export function issueAdminSession(res: Response, config: Account2ServiceConfig): string {
    cleanupExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + config.adminSessionTtlMs;
    activeSessions.set(token, expiresAt);
    const cookieParts = [
        `${config.adminSessionCookieName}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(config.adminSessionTtlMs / 1000)}`,
    ];
    if (config.secureCookies) {
        cookieParts.push('Secure');
    }
    res.setHeader('Set-Cookie', cookieParts.join('; '));
    return token;
}

export function clearAdminSession(req: Request, res: Response, config: Account2ServiceConfig) {
    const token = getSessionToken(req, config);
    if (token) {
        activeSessions.delete(token);
    }
    const cookieParts = [
        `${config.adminSessionCookieName}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=0',
    ];
    if (config.secureCookies) {
        cookieParts.push('Secure');
    }
    res.setHeader('Set-Cookie', cookieParts.join('; '));
}
