import { doc, getDocFromServer } from "firebase/firestore";
import { auth, db } from "../../firebase";

export const GOOGLE_SCRIPT_URL =
    "https://script.google.com/macros/s/AKfycbzSq8vnL_P9DOkiXluKReSUNFILqlRkK-WxnPC_Q0BNt23rFHbLpRlkvPudbqElqw5h/exec";

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
};

type OperationReceipt = {
    action?: string;
    requestId?: string;
    success?: boolean;
    responseJson?: string;
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
                ? "Google Apps Script החזיר עמוד HTML במקום JSON. בודק אם הפעולה כבר הושלמה..."
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

async function readOperationReceipt<T>(
    requestId: string,
    action: string
): Promise<T | null> {
    // The receipt is written by Apps Script before ContentService returns. In
    // the normal lost-response case it is already visible immediately; the
    // short extra polls cover Firestore propagation without making the user sit
    // through multiple Apps Script retries.
    const delays = [0, 100, 250];

    for (const delay of delays) {
        if (delay > 0) await sleep(delay);

        try {
            const snapshot = await getDocFromServer(
                doc(db, "operationReceipts", requestId)
            );

            if (!snapshot.exists()) continue;

            const receipt = snapshot.data() as OperationReceipt;
            if (
                receipt.success !== true ||
                receipt.action !== action ||
                receipt.requestId !== requestId ||
                !receipt.responseJson
            ) {
                continue;
            }

            const parsed = JSON.parse(receipt.responseJson) as T;
            console.info("Apps Script response recovered from Firestore receipt", {
                action,
                requestId,
            });
            return parsed;
        } catch (error) {
            // This can happen temporarily if the receipt rule has not been
            // deployed yet. Keep the old idempotent retry path as fallback.
            console.warn("Could not read Apps Script operation receipt", {
                action,
                requestId,
                error,
            });
            return null;
        }
    }

    return null;
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
    const retries = Math.max(0, options.retries ?? 2);
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);

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
            const response = await fetch(GOOGLE_SCRIPT_URL, {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(authenticatedPayload),
            });

            const parsed = await parseAppsScriptResponse<T>(response);

            if (attempt > 0) {
                console.info("Apps Script request confirmed after retry", {
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

                const receiptResponse = await readOperationReceipt<T>(requestId, action);
                if (receiptResponse) {
                    console.info("Apps Script request confirmed without retry", {
                        action,
                        requestId,
                        totalMs: Math.round(performance.now() - startedAt),
                    });
                    return receiptResponse;
                }
            }

            if (attempt >= retries) break;

            if (error instanceof AppsScriptInvalidResponseError) {
                await sleep(25);
            } else {
                await sleep(retryDelayMs * (attempt + 1));
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
        retryDelayMs: options.retryDelayMs ?? 200,
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
