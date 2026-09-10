"use strict";

const express = require("express");
const crypto = require("crypto");
const { chromium } = require("playwright-core");

const app = express();
app.use(express.json({ limit: "1mb" }));

// ==================================================
// CONFIGURACIÓN
// ==================================================

const PORT = Number(process.env.PORT || 3001);

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;
const SESSION_SECRET = process.env.SESSION_SECRET;

// Endpoint compartido de Browserless.
// Puedes cambiarlo con BROWSERLESS_WS_BASE si tu cuenta usa otra región/fleet.
const BROWSERLESS_WS_BASE =
    process.env.BROWSERLESS_WS_BASE ||
    "wss://production-sfo.browserless.io";

// Browserless limita el tiempo de reconnect según el plan.
// Starter permite tiempos mayores que Free; ajusta esta variable en Vercel.
const RECONNECT_TIMEOUT_MS = clampNumber(
    process.env.RECONNECT_TIMEOUT_MS,
    60_000,
    10_000,
    300_000
);

// La URL interactiva no debe durar más que la sesión reconectable.
const LIVE_URL_TIMEOUT_MS = clampNumber(
    process.env.LIVE_URL_TIMEOUT_MS,
    RECONNECT_TIMEOUT_MS,
    10_000,
    RECONNECT_TIMEOUT_MS
);

const NAVIGATION_TIMEOUT_MS = clampNumber(
    process.env.NAVIGATION_TIMEOUT_MS,
    30_000,
    5_000,
    120_000
);

// Tiempo adicional que aceptaremos un token firmado.
// No mantiene vivo Browserless; solo limita la validez del sessionId.
const SESSION_TOKEN_TTL_MS = clampNumber(
    process.env.SESSION_TOKEN_TTL_MS,
    15 * 60_000,
    60_000,
    24 * 60 * 60_000
);

// ==================================================
// MIDDLEWARE
// ==================================================

app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

// ==================================================
// HEALTH CHECK
// ==================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "scraper-browser-worker",
        status: "online",
        architecture: "vercel-browserless-stateless",
        browserlessConfigured: Boolean(BROWSERLESS_TOKEN),
        sessionSecretConfigured: Boolean(SESSION_SECRET)
    });
});

// ==================================================
// CREAR SESIÓN
// ==================================================

app.post("/session", async (req, res) => {
    let browser = null;
    let handedOff = false;

    try {
        assertConfiguration();

        const { url } = req.body || {};
        const targetUrl = validateTargetUrl(url);

        browser = await connectToNewBrowserlessSession();

        const { context, page } = await getOrCreatePage(browser);

        await page.goto(targetUrl.toString(), {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS
        });

        // Damos un instante a desafíos que aparecen después del DOMContentLoaded.
        await page.waitForTimeout(1200).catch(() => {});

        const captchaDetected = await detectCaptcha(page);

        let verificationUrl = null;

        if (captchaDetected) {
            verificationUrl = await createLiveUrl(page);
        }

        const handoff = await handoffBrowserSession(page, browser);
        handedOff = true;

        const sessionId = createSignedSessionToken({
            wsEndpoint: handoff.browserWSEndpoint,
            currentUrl: page.url()
        });

        return res.status(200).json({
            success: true,
            sessionId,
            status: captchaDetected ? "verification_required" : "ready",
            requiresVerification: captchaDetected,
            verificationUrl,
            url: page.url(),
            message: captchaDetected
                ? "Manual verification is required. Open verificationUrl, complete it, then call the status endpoint with the returned sessionId."
                : "Browser session is ready."
        });
    } catch (error) {
        console.error("Create session error:", safeError(error));

        if (browser && !handedOff) {
            await closeQuietly(browser);
        }

        return sendError(
            res,
            error.httpStatus || 500,
            error.code || "SESSION_CREATE_FAILED",
            error.publicMessage || "Could not create browser session."
        );
    }
});

// ==================================================
// ESTADO DE SESIÓN
// ==================================================

app.get("/session/:sessionId", async (req, res) => {
    let browser = null;
    let handedOff = false;

    try {
        assertConfiguration();

        const sessionData = verifySignedSessionToken(req.params.sessionId);

        browser = await reconnectToBrowserlessSession(
            sessionData.wsEndpoint
        );

        const { page } = await getOrCreatePage(browser);

        await page.waitForTimeout(500).catch(() => {});

        const captchaDetected = await detectCaptcha(page);

        let verificationUrl = null;

        if (captchaDetected) {
            verificationUrl = await createLiveUrl(page);
        }

        const handoff = await handoffBrowserSession(page, browser);
        handedOff = true;

        // Browserless entrega un endpoint de reconexión nuevo.
        // Por eso devolvemos también un sessionId actualizado.
        const nextSessionId = createSignedSessionToken({
            wsEndpoint: handoff.browserWSEndpoint,
            currentUrl: page.url()
        });

        return res.json({
            success: true,
            sessionId: nextSessionId,
            status: captchaDetected ? "verification_required" : "ready",
            requiresVerification: captchaDetected,
            verificationUrl,
            url: page.url()
        });
    } catch (error) {
        console.error("Session status error:", safeError(error));

        if (browser && !handedOff) {
            await closeQuietly(browser);
        }

        return sendSessionError(res, error);
    }
});

// ==================================================
// OBTENER HTML DE LA SESIÓN
// ==================================================

app.get("/session/:sessionId/html", async (req, res) => {
    let browser = null;
    let handedOff = false;

    try {
        assertConfiguration();

        const sessionData = verifySignedSessionToken(req.params.sessionId);

        browser = await reconnectToBrowserlessSession(
            sessionData.wsEndpoint
        );

        const { page } = await getOrCreatePage(browser);

        const captchaDetected = await detectCaptcha(page);

        if (captchaDetected) {
            const verificationUrl = await createLiveUrl(page);

            const handoff = await handoffBrowserSession(page, browser);
            handedOff = true;

            const nextSessionId = createSignedSessionToken({
                wsEndpoint: handoff.browserWSEndpoint,
                currentUrl: page.url()
            });

            return res.status(403).json({
                success: false,
                sessionId: nextSessionId,
                requiresVerification: true,
                status: "verification_required",
                verificationUrl,
                url: page.url(),
                error: {
                    code: "CAPTCHA_REQUIRED",
                    message:
                        "Manual verification is still required. Complete verificationUrl and check the session again."
                }
            });
        }

        const html = await page.content();

        // Conservamos la sesión, igual que hacía el worker original.
        const handoff = await handoffBrowserSession(page, browser);
        handedOff = true;

        const nextSessionId = createSignedSessionToken({
            wsEndpoint: handoff.browserWSEndpoint,
            currentUrl: page.url()
        });

        return res.json({
            success: true,
            sessionId: nextSessionId,
            status: "ready",
            requiresVerification: false,
            url: page.url(),
            html
        });
    } catch (error) {
        console.error("HTML extraction error:", safeError(error));

        if (browser && !handedOff) {
            await closeQuietly(browser);
        }

        return sendSessionError(
            res,
            error,
            "HTML_EXTRACTION_FAILED",
            "Could not extract page HTML."
        );
    }
});

// ==================================================
// CERRAR SESIÓN
// ==================================================

app.delete("/session/:sessionId", async (req, res) => {
    let browser = null;

    try {
        assertConfiguration();

        const sessionData = verifySignedSessionToken(req.params.sessionId);

        browser = await reconnectToBrowserlessSession(
            sessionData.wsEndpoint
        );

        // IMPORTANTE:
        // Aquí NO llamamos Browserless.reconnect.
        // browser.close() termina deliberadamente la sesión remota.
        await browser.close();
        browser = null;

        return res.json({
            success: true,
            status: "closed"
        });
    } catch (error) {
        console.error("Close session error:", safeError(error));

        if (browser) {
            await closeQuietly(browser);
        }

        return sendSessionError(
            res,
            error,
            "SESSION_CLOSE_FAILED",
            "Could not close browser session."
        );
    }
});

// ==================================================
// CONEXIÓN BROWSERLESS
// ==================================================

async function connectToNewBrowserlessSession() {
    const token = encodeURIComponent(BROWSERLESS_TOKEN);

    const wsUrl =
        `${BROWSERLESS_WS_BASE}/stealth` +
        `?token=${token}` +
        `&solveCaptchas=true` +
        `&blockAds=true`;

    return chromium.connectOverCDP(wsUrl, {
        timeout: NAVIGATION_TIMEOUT_MS
    });
}

async function reconnectToBrowserlessSession(wsEndpoint) {
    const endpoint = appendToken(wsEndpoint, BROWSERLESS_TOKEN);

    try {
        return await chromium.connectOverCDP(endpoint, {
            timeout: NAVIGATION_TIMEOUT_MS
        });
    } catch (error) {
        const wrapped = new Error("Browserless session is unavailable.");
        wrapped.code = "SESSION_EXPIRED";
        wrapped.httpStatus = 410;
        wrapped.publicMessage =
            "The Browserless session expired or can no longer be reconnected. Create a new session.";
        wrapped.cause = error;
        throw wrapped;
    }
}

async function getOrCreatePage(browser) {
    let context = browser.contexts()[0];

    if (!context) {
        context = await browser.newContext();
    }

    let pages = context.pages();
    let page = pages.find((candidate) => !candidate.isClosed());

    if (!page) {
        page = await context.newPage();
    }

    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    return { context, page };
}

// ==================================================
// HANDOFF / RECONEXIÓN
// ==================================================

async function handoffBrowserSession(page, browser) {
    const cdp = await page.context().newCDPSession(page);

    const result = await cdp.send("Browserless.reconnect", {
        timeout: RECONNECT_TIMEOUT_MS
    });

    if (!result || !result.browserWSEndpoint) {
        const error = new Error(
            "Browserless did not return a reconnection endpoint."
        );
        error.code = "RECONNECT_FAILED";
        error.httpStatus = 502;
        error.publicMessage =
            "Browserless could not keep the browser session alive.";
        throw error;
    }

    // Después de Browserless.reconnect, cerrar esta conexión de Playwright
    // deja el navegador remoto vivo durante el timeout indicado.
    await browser.close();

    return result;
}

// ==================================================
// LIVE URL PARA VERIFICACIÓN HUMANA
// ==================================================

async function createLiveUrl(page) {
    try {
        const cdp = await page.context().newCDPSession(page);

        const result = await cdp.send("Browserless.liveURL", {
            timeout: LIVE_URL_TIMEOUT_MS,
            interactable: true,
            resizable: true,
            showBrowserInterface: true,
            quality: 70,
            type: "jpeg"
        });

        if (result?.error) {
            console.error("Browserless.liveURL error:", result.error);
            return null;
        }

        return result?.liveURL || null;
    } catch (error) {
        console.error("Live URL creation error:", safeError(error));
        return null;
    }
}

// ==================================================
// DETECCIÓN CAPTCHA / VERIFICACIÓN
// ==================================================

async function detectCaptcha(page) {
    try {
        const title = await page.title().catch(() => "");

        const bodyText = await page
            .locator("body")
            .innerText({ timeout: 4000 })
            .catch(() => "");

        const combinedText = `${title} ${bodyText}`
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();

        const textSignals = [
            "captcha",
            "recaptcha",
            "hcaptcha",
            "verify you are human",
            "verify that you are human",
            "verification required",
            "security verification",
            "security check",
            "checking your browser",
            "challenge-platform",
            "por favor complete la validación",
            "complete la validación",
            "verificación de seguridad",
            "verifica que eres humano",
            "verifique que es humano"
        ];

        if (textSignals.some((signal) => combinedText.includes(signal))) {
            return true;
        }

        const selectorSignals = [
            'iframe[src*="recaptcha"]',
            'iframe[src*="hcaptcha"]',
            'iframe[src*="challenges.cloudflare.com"]',
            ".g-recaptcha",
            ".h-captcha",
            '[data-sitekey]',
            '#challenge-form',
            'input[name="cf-turnstile-response"]',
            'textarea[name="g-recaptcha-response"]',
            'textarea[name="h-captcha-response"]'
        ];

        for (const selector of selectorSignals) {
            const count = await page.locator(selector).count().catch(() => 0);

            if (count > 0) {
                return true;
            }
        }

        return false;
    } catch (error) {
        console.error("CAPTCHA detection error:", safeError(error));
        return false;
    }
}

// ==================================================
// SESSION ID FIRMADO
// ==================================================

function createSignedSessionToken({ wsEndpoint, currentUrl }) {
    const now = Date.now();

    const payload = {
        v: 1,
        ws: wsEndpoint,
        url: currentUrl || null,
        iat: now,
        exp: now + SESSION_TOKEN_TTL_MS
    };

    const encodedPayload = base64UrlEncode(
        Buffer.from(JSON.stringify(payload), "utf8")
    );

    const signature = crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    return `${encodedPayload}.${signature}`;
}

function verifySignedSessionToken(token) {
    if (!token || typeof token !== "string") {
        throwSessionTokenError();
    }

    const separatorIndex = token.lastIndexOf(".");

    if (separatorIndex <= 0) {
        throwSessionTokenError();
    }

    const encodedPayload = token.slice(0, separatorIndex);
    const providedSignature = token.slice(separatorIndex + 1);

    const expectedSignature = crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(encodedPayload)
        .digest("base64url");

    const providedBuffer = Buffer.from(providedSignature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
        providedBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
        throwSessionTokenError();
    }

    let payload;

    try {
        payload = JSON.parse(
            Buffer.from(encodedPayload, "base64url").toString("utf8")
        );
    } catch {
        throwSessionTokenError();
    }

    if (
        payload?.v !== 1 ||
        typeof payload?.ws !== "string" ||
        !payload.ws.startsWith("wss://")
    ) {
        throwSessionTokenError();
    }

    if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) {
        const error = new Error("Session token expired.");
        error.code = "SESSION_TOKEN_EXPIRED";
        error.httpStatus = 410;
        error.publicMessage =
            "The session identifier expired. Create a new browser session.";
        throw error;
    }

    return {
        wsEndpoint: payload.ws,
        currentUrl: payload.url || null
    };
}

function throwSessionTokenError() {
    const error = new Error("Invalid session token.");
    error.code = "INVALID_SESSION_ID";
    error.httpStatus = 400;
    error.publicMessage = "The supplied sessionId is not valid.";
    throw error;
}

// ==================================================
// VALIDACIÓN URL
// ==================================================

function validateTargetUrl(value) {
    if (!value || typeof value !== "string") {
        const error = new Error("URL is required.");
        error.code = "MISSING_URL";
        error.httpStatus = 400;
        error.publicMessage = "A URL is required.";
        throw error;
    }

    let targetUrl;

    try {
        targetUrl = new URL(value);
    } catch {
        const error = new Error("Invalid URL.");
        error.code = "INVALID_URL";
        error.httpStatus = 400;
        error.publicMessage = "The provided URL is not valid.";
        throw error;
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
        const error = new Error("Unsupported protocol.");
        error.code = "UNSUPPORTED_PROTOCOL";
        error.httpStatus = 400;
        error.publicMessage =
            "Only HTTP and HTTPS URLs are supported.";
        throw error;
    }

    // Evita destinos locales evidentes.
    // Para producción sensible, es mejor además usar una allowlist de dominios.
    const hostname = targetUrl.hostname.toLowerCase();

    if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname.endsWith(".local")
    ) {
        const error = new Error("Local targets are not allowed.");
        error.code = "LOCAL_URL_NOT_ALLOWED";
        error.httpStatus = 400;
        error.publicMessage = "Local URLs are not allowed.";
        throw error;
    }

    return targetUrl;
}

// ==================================================
// HELPERS
// ==================================================

function appendToken(endpoint, token) {
    const separator = endpoint.includes("?") ? "&" : "?";
    return `${endpoint}${separator}token=${encodeURIComponent(token)}`;
}

function base64UrlEncode(buffer) {
    return buffer.toString("base64url");
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function assertConfiguration() {
    if (!BROWSERLESS_TOKEN) {
        const error = new Error("BROWSERLESS_TOKEN is missing.");
        error.code = "BROWSERLESS_NOT_CONFIGURED";
        error.httpStatus = 500;
        error.publicMessage =
            "BROWSERLESS_TOKEN is not configured on the server.";
        throw error;
    }

    if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
        const error = new Error(
            "SESSION_SECRET is missing or shorter than 32 characters."
        );
        error.code = "SESSION_SECRET_NOT_CONFIGURED";
        error.httpStatus = 500;
        error.publicMessage =
            "SESSION_SECRET must be configured with at least 32 characters.";
        throw error;
    }
}

async function closeQuietly(browser) {
    try {
        await browser.close();
    } catch (error) {
        console.error("Browser close error:", safeError(error));
    }
}

function sendSessionError(
    res,
    error,
    fallbackCode = "SESSION_STATUS_FAILED",
    fallbackMessage = "Could not access browser session."
) {
    return sendError(
        res,
        error.httpStatus || 500,
        error.code || fallbackCode,
        error.publicMessage || fallbackMessage
    );
}

function sendError(res, status, code, message) {
    return res.status(status).json({
        success: false,
        error: {
            code,
            message
        }
    });
}

function safeError(error) {
    return {
        name: error?.name,
        message: error?.message,
        code: error?.code
    };
}

// ==================================================
// MANEJO 404
// ==================================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: {
            code: "NOT_FOUND",
            message: "Endpoint not found."
        }
    });
});

// ==================================================
// EXPORT VERCEL + EJECUCIÓN LOCAL
// ==================================================


module.exports = app;

// Si ejecutas el archivo directamente con Node, también funciona localmente.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Browser worker running on port ${PORT}`);
    });
}
