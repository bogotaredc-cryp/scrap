"use strict";

const express = require("express");
const { chromium } = require("playwright");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3001;

// ==================================================
// CONFIGURACIÓN
// ==================================================

const SESSION_TTL = 10 * 60 * 1000; // 10 minutos

// Sesiones activas en memoria.
//
// sessionId -> {
//     browser,
//     context,
//     page,
//     url,
//     createdAt,
//     lastActivity
// }
const sessions = new Map();


// ==================================================
// HEALTH CHECK
// ==================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "scraper-browser-worker",
        status: "online",
        activeSessions: sessions.size
    });
});


// ==================================================
// CREAR SESIÓN
// ==================================================

app.post("/session", async (req, res) => {
    try {
        const { url } = req.body || {};

        if (!url) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "MISSING_URL",
                    message: "A URL is required."
                }
            });
        }

        let targetUrl;

        try {
            targetUrl = new URL(url);
        } catch {
            return res.status(400).json({
                success: false,
                error: {
                    code: "INVALID_URL",
                    message: "The provided URL is not valid."
                }
            });
        }

        if (!["http:", "https:"].includes(targetUrl.protocol)) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "UNSUPPORTED_PROTOCOL",
                    message: "Only HTTP and HTTPS URLs are supported."
                }
            });
        }

        // --------------------------------------------------
        // Crear navegador
        // --------------------------------------------------

        const browser = await chromium.launch({
            headless: true
        });

        // --------------------------------------------------
        // Crear contexto independiente
        // --------------------------------------------------

        const context = await browser.newContext({
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/131.0.0.0 Safari/537.36"
        });

        const page = await context.newPage();

        // --------------------------------------------------
        // Navegar
        // --------------------------------------------------

        await page.goto(targetUrl.toString(), {
            waitUntil: "domcontentloaded",
            timeout: 30000
        });

        // --------------------------------------------------
        // Crear ID de sesión
        // --------------------------------------------------

        const sessionId = createSessionId();

        sessions.set(sessionId, {
            browser,
            context,
            page,
            url: targetUrl.toString(),
            createdAt: Date.now(),
            lastActivity: Date.now()
        });

        // --------------------------------------------------
        // Detectar CAPTCHA
        // --------------------------------------------------

        const captchaDetected = await detectCaptcha(page);

        if (captchaDetected) {
            return res.status(200).json({
                success: true,
                sessionId,
                requiresVerification: true,
                status: "verification_required",
                message:
                    "Manual CAPTCHA verification is required.",
                url: targetUrl.toString()
            });
        }

        // --------------------------------------------------
        // No CAPTCHA
        // --------------------------------------------------

        return res.status(200).json({
            success: true,
            sessionId,
            requiresVerification: false,
            status: "ready",
            message: "Browser session is ready.",
            url: targetUrl.toString()
        });

    } catch (error) {
        console.error("Create session error:", error);

        return res.status(500).json({
            success: false,
            error: {
                code: "SESSION_CREATE_FAILED",
                message: "Could not create browser session."
            }
        });
    }
});


// ==================================================
// ESTADO DE SESIÓN
// ==================================================

app.get("/session/:sessionId", async (req, res) => {
    const { sessionId } = req.params;

    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: {
                code: "SESSION_NOT_FOUND",
                message: "Browser session was not found."
            }
        });
    }

    try {
        session.lastActivity = Date.now();

        const page = session.page;

        const captchaDetected = await detectCaptcha(page);

        if (captchaDetected) {
            return res.json({
                success: true,
                sessionId,
                status: "verification_required",
                requiresVerification: true,
                url: page.url()
            });
        }

        return res.json({
            success: true,
            sessionId,
            status: "ready",
            requiresVerification: false,
            url: page.url()
        });

    } catch (error) {
        console.error("Session status error:", error);

        return res.status(500).json({
            success: false,
            error: {
                code: "SESSION_STATUS_FAILED",
                message: "Could not check browser session."
            }
        });
    }
});


// ==================================================
// OBTENER HTML DE LA SESIÓN
// ==================================================

app.get("/session/:sessionId/html", async (req, res) => {
    const { sessionId } = req.params;

    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: {
                code: "SESSION_NOT_FOUND",
                message: "Browser session was not found."
            }
        });
    }

    try {
        session.lastActivity = Date.now();

        const captchaDetected =
            await detectCaptcha(session.page);

        if (captchaDetected) {
            return res.status(403).json({
                success: false,
                requiresVerification: true,
                error: {
                    code: "CAPTCHA_REQUIRED",
                    message:
                        "Manual CAPTCHA verification is still required."
                }
            });
        }

        const html = await session.page.content();

        return res.json({
            success: true,
            sessionId,
            url: session.page.url(),
            html
        });

    } catch (error) {
        console.error("HTML extraction error:", error);

        return res.status(500).json({
            success: false,
            error: {
                code: "HTML_EXTRACTION_FAILED",
                message: "Could not extract page HTML."
            }
        });
    }
});


// ==================================================
// CERRAR SESIÓN
// ==================================================

app.delete("/session/:sessionId", async (req, res) => {
    const { sessionId } = req.params;

    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({
            success: false,
            error: {
                code: "SESSION_NOT_FOUND",
                message: "Browser session was not found."
            }
        });
    }

    try {
        await session.browser.close();
    } catch (error) {
        console.error(
            "Browser close error:",
            error
        );
    }

    sessions.delete(sessionId);

    return res.json({
        success: true,
        sessionId,
        status: "closed"
    });
});


// ==================================================
// DETECCIÓN CAPTCHA
// ==================================================

async function detectCaptcha(page) {
    try {
        const title = await page.title();

        const bodyText = await page.locator("body").innerText({
            timeout: 5000
        }).catch(() => "");

        const combinedText =
            `${title} ${bodyText}`
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();

        return (
            combinedText.includes("captcha") ||
            combinedText.includes("recaptcha") ||
            combinedText.includes(
                "por favor complete la validación"
            ) ||
            combinedText.includes(
                "complete la validación"
            ) ||
            combinedText.includes(
                "verificación de seguridad"
            ) ||
            combinedText.includes(
                "security verification"
            ) ||
            combinedText.includes(
                "verify you are human"
            )
        );

    } catch (error) {
        console.error(
            "CAPTCHA detection error:",
            error
        );

        return false;
    }
}


// ==================================================
// GENERAR ID DE SESIÓN
// ==================================================

function createSessionId() {
    return (
        Date.now().toString(36) +
        "-" +
        Math.random()
            .toString(36)
            .substring(2, 12)
    );
}


// ==================================================
// LIMPIEZA AUTOMÁTICA DE SESIONES
// ==================================================

setInterval(async () => {
    const now = Date.now();

    for (const [sessionId, session] of sessions) {
        const inactiveTime =
            now - session.lastActivity;

        if (inactiveTime > SESSION_TTL) {
            console.log(
                `Closing expired session: ${sessionId}`
            );

            try {
                await session.browser.close();
            } catch (error) {
                console.error(
                    "Expired browser close error:",
                    error
                );
            }

            sessions.delete(sessionId);
        }
    }
}, 60 * 1000);


// ==================================================
// START SERVER
// ==================================================

app.listen(PORT, () => {
    console.log(
        `Browser worker running on port ${PORT}`
    );
});

