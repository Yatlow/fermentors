export const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

export type AppsScriptEnvelope<T = unknown> = {
    success: boolean;
    result?: T;
    results?: T;
    error?: string;
    message?: string;
    warnings?: string[];
    [key: string]: unknown;
};

type RetryOptions = {
    /**
     * Retry only when the caller is known to be safe/idempotent.
     * Do NOT enable this for arbitrary writes: a request may have succeeded
     * even when Google returns a broken HTML/redirect response afterwards.
     */
    retries?: number;
    retryDelayMs?: number;
};

export class AppsScriptInvalidResponseError extends Error {
    readonly status: number;
    readonly responsePreview: string;

    constructor(status: number, responsePreview: string) {
        super(
            responsePreview.startsWith("HTML")
                ? "Google Apps Script החזיר עמוד HTML במקום תשובת JSON. ייתכן שהפעולה עצמה כבר הושלמה."
                : "Google Apps Script החזיר תשובה לא תקינה במקום JSON."
        );
        this.name = "AppsScriptInvalidResponseError";
        this.status = status;
        this.responsePreview = responsePreview;
    }
}

function responsePreview(text: string): string {
    const trimmed = text.trim();
    const looksLikeHtml = /^<!doctype html/i.test(trimmed) || /^<html/i.test(trimmed);

    if (looksLikeHtml) {
        const title = trimmed.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
        const message = trimmed.match(/class=["']errorMessage["'][^>]*>([^<]*)<\/p>/i)?.[1]?.trim();
        return `HTML${title ? ` (${title})` : ""}${message ? `: ${message}` : ""}`;
    }

    if (!trimmed) return "empty response";
    return trimmed.slice(0, 240);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function parseAppsScriptResponse<T>(response: Response): Promise<T> {
    const text = await response.text();

    let parsed: T;
    try {
        parsed = JSON.parse(text) as T;
    } catch {
        throw new AppsScriptInvalidResponseError(response.status, responsePreview(text));
    }

    if (!response.ok) {
        const envelope = parsed as AppsScriptEnvelope;
        throw new Error(
            envelope.error ||
            envelope.message ||
            `Google Apps Script request failed (${response.status})`
        );
    }

    return parsed;
}

export function createAppsScriptRequestId(prefix = "request"): string {
    const randomUuid = globalThis.crypto?.randomUUID?.();
    if (randomUuid) return `${prefix}-${randomUuid}`;

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function callAppsScriptPost<T>(
    payload: Record<string, unknown>,
    options: RetryOptions = {}
): Promise<T> {
    const retries = Math.max(0, options.retries ?? 0);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(payload),
            });

            return await parseAppsScriptResponse<T>(response);
        } catch (error) {
            lastError = error;

            if (attempt >= retries) break;

            // Retrying writes is only allowed when the caller explicitly opted in.
            // Such callers must use a server-side requestId/idempotency guard.
            await sleep(retryDelayMs * (attempt + 1));
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error("Google Apps Script request failed");
}

export async function callAppsScriptGet<T>(
    params: Record<string, string>,
    options: RetryOptions = { retries: 1 }
): Promise<T> {
    const retries = Math.max(0, options.retries ?? 1);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 400);

    const url = new URL(GOOGLE_SCRIPT_URL);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url.toString());
            return await parseAppsScriptResponse<T>(response);
        } catch (error) {
            lastError = error;
            if (attempt >= retries) break;
            await sleep(retryDelayMs * (attempt + 1));
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error("Google Apps Script request failed");
}

export function unwrapAppsScriptResult<T>(
    envelope: AppsScriptEnvelope<T>,
    fallbackMessage = "Google Apps Script request failed"
): T {
    if (!envelope.success) {
        throw new Error(envelope.error || envelope.message || fallbackMessage);
    }

    return envelope.result as T;
}
