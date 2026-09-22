import { auth } from "../../firebase";
import { runtimeConfig } from "../../config/runtimeConfig";

export const GOOGLE_SCRIPT_URL = runtimeConfig.appsScriptUrl;

export type AppsScriptEnvelope<T = unknown> = {
    success: boolean;
    result?: T;
    results?: T;
    error?: string;
    message?: string;
    warnings?: string[];
    requestId?: string;
    duplicate?: boolean;
    [key: string]: unknown;
};

type RetryOptions = {
    retries?: number;
    retryDelayMs?: number;
    timeoutMs?: number;
};

export class AppsScriptInvalidResponseError extends Error {
    readonly status: number;
    readonly responsePreview: string;
    readonly responseUrl: string;
    readonly redirected: boolean;
    readonly contentType: string;

    constructor(response: Response, preview: string) {
        super(
            preview.startsWith("HTML")
                ? "Google Apps Script החזיר עמוד HTML במקום JSON. מאמת את הפעולה שוב..."
                : "Google Apps Script החזיר תשובה לא תקינה במקום JSON."
        );
        this.name = "AppsScriptInvalidResponseError";
        this.status = response.status;
        this.responsePreview = preview;
        this.responseUrl = response.url;
        this.redirected = response.redirected;
        this.contentType = response.headers.get("content-type") || "";
    }
}

export class AppsScriptTimeoutError extends Error {
    readonly timeoutMs: number;

    constructor(timeoutMs: number) {
        super(`Google Apps Script לא החזיר תשובה תוך ${Math.round(timeoutMs / 1000)} שניות.`);
        this.name = "AppsScriptTimeoutError";
        this.timeoutMs = timeoutMs;
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

async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new AppsScriptTimeoutError(timeoutMs);
        }
        throw error;
    } finally {
        window.clearTimeout(timeoutId);
    }
}

async function parseAppsScriptResponse<T>(response: Response): Promise<T> {
    const text = await response.text();

    let parsed: T;
    try {
        parsed = JSON.parse(text) as T;
    } catch {
        throw new AppsScriptInvalidResponseError(response, responsePreview(text));
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

async function getAppsScriptIdToken(): Promise<string> {
    const user = auth.currentUser;
    if (!user) {
        throw new Error("אין משתמש מחובר. יש להתחבר מחדש.");
    }

    return user.getIdToken();
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
    // One retry is enough because the exact same requestId is reused. If the
    // first mutation completed but Google's ContentService response was lost,
    // the retry is served by the server-side idempotency cache and cannot write
    // the mutation twice.
    const retries = Math.max(0, options.retries ?? 1);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 150);
    const timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);

    const action = String(payload.action || "request");
    const requestId =
        typeof payload.requestId === "string" && payload.requestId.trim()
            ? payload.requestId.trim()
            : createAppsScriptRequestId(action);

    const idToken = await getAppsScriptIdToken();
    const authenticatedPayload = {
        ...payload,
        requestId,
        idToken,
    };

    let lastError: unknown;
    const startedAt = performance.now();

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const attemptStartedAt = performance.now();
            const response = await fetchWithTimeout(
                GOOGLE_SCRIPT_URL,
                {
                    method: "POST",
                    headers: { "Content-Type": "text/plain;charset=utf-8" },
                    body: JSON.stringify(authenticatedPayload),
                },
                timeoutMs
            );

            const parsed = await parseAppsScriptResponse<T>(response);

            if (attempt > 0) {
                console.info("Apps Script request confirmed by idempotent retry", {
                    action,
                    requestId,
                    attempts: attempt + 1,
                    attemptMs: Math.round(performance.now() - attemptStartedAt),
                    totalMs: Math.round(performance.now() - startedAt),
                });
            }

            return parsed;
        } catch (error) {
            lastError = error;

            if (error instanceof AppsScriptInvalidResponseError) {
                console.warn("Apps Script invalid response", {
                    action,
                    requestId,
                    attempt: attempt + 1,
                    status: error.status,
                    responseUrl: error.responseUrl,
                    redirected: error.redirected,
                    contentType: error.contentType,
                    preview: error.responsePreview,
                    elapsedMs: Math.round(performance.now() - startedAt),
                });
            } else if (error instanceof AppsScriptTimeoutError) {
                console.warn("Apps Script request timed out", {
                    action,
                    requestId,
                    attempt: attempt + 1,
                    timeoutMs: error.timeoutMs,
                    elapsedMs: Math.round(performance.now() - startedAt),
                });
            }

            if (attempt >= retries) break;

            // A broken HTML/redirect response or a timeout may mean the mutation
            // already completed. Retry with the SAME requestId so the server-side
            // idempotency guard turns this into a safe confirmation request.
            if (error instanceof AppsScriptInvalidResponseError || error instanceof AppsScriptTimeoutError) {
                await sleep(10);
            } else {
                await sleep(retryDelayMs);
            }
        }
    }

    console.error("Apps Script request exhausted retries", {
        action,
        requestId,
        attempts: retries + 1,
        totalMs: Math.round(performance.now() - startedAt),
    });

    throw lastError instanceof Error
        ? lastError
        : new Error("Google Apps Script request failed");
}

export async function callAppsScriptGet<T>(
    params: Record<string, string>,
    options: RetryOptions = { retries: 1 }
): Promise<T> {
    return callAppsScriptPost<T>(params, {
        retries: options.retries ?? 1,
        retryDelayMs: options.retryDelayMs ?? 150,
        timeoutMs: options.timeoutMs ?? 30000,
    });
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
