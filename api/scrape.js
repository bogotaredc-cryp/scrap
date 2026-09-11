"use strict";

const crypto = require("crypto");
const cheerio = require("cheerio");
const { chromium } = require("playwright-core");


/* =========================================================
   CONFIGURATION
   ========================================================= */

const BROWSERLESS_TOKEN =
    process.env.BROWSERLESS_TOKEN;

const SESSION_SECRET =
    process.env.SESSION_SECRET;

const BROWSERLESS_WS_BASE =
    process.env.BROWSERLESS_WS_BASE ||
    "wss://production-sfo.browserless.io";

const RECONNECT_TIMEOUT_MS =
    60_000;

const LIVE_URL_TIMEOUT_MS =
    60_000;

const NAVIGATION_TIMEOUT_MS =
    30_000;

const SESSION_TOKEN_TTL_MS =
    15 * 60_000;


/* =========================================================
   API HANDLER
   ========================================================= */

module.exports = async function handler(req, res) {

    if (req.method !== "POST") {

        return res.status(405).json({
            success: false,
            error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Only POST requests are allowed."
            }
        });

    }


    try {

        assertConfiguration();

        const {
            action = "start",
            url,
            sessionId,
            method = "GET",
            timeout = 10,
            mode = "auto",
            content = []
        } = req.body || {};


        /* =====================================================
           START
           ===================================================== */

        if (action === "start") {

            return await startScrapingSession({
                res,
                url,
                method,
                timeout,
                mode,
                content
            });

        }


        /* =====================================================
           CONTINUE
           ===================================================== */

        if (action === "continue") {

            return await continueScrapingSession({
                res,
                sessionId,
                method,
                timeout,
                mode,
                content
            });

        }


        return res.status(400).json({
            success: false,
            error: {
                code: "INVALID_ACTION",
                message: "Unsupported scraping action."
            }
        });


    } catch (error) {

        console.error(
            "Scraper API error:",
            safeError(error)
        );


        return res.status(
            error.httpStatus || 500
        ).json({
            success: false,
            error: {
                code:
                    error.code ||
                    "SCRAPER_FAILED",

                message:
                    error.publicMessage ||
                    "The requested source could not be processed."
            }
        });

    }

};


/* =========================================================
   START SCRAPING SESSION
   ========================================================= */

async function startScrapingSession({
    res,
    url,
    method,
    timeout,
    mode,
    content
}) {

    validateConfiguration({
        method,
        timeout,
        content
    });

    const targetUrl =
        validateTargetUrl(url);

    const startedAt =
        Date.now();

    let browser = null;
    let handedOff = false;


    try {

        browser =
            await connectToNewBrowserlessSession();

        const { page } =
            await getOrCreatePage(browser);


        await page.goto(
            targetUrl.toString(),
            {
                waitUntil:
                    "domcontentloaded",

                timeout:
                    Math.min(
                        Number(timeout) * 1000,
                        NAVIGATION_TIMEOUT_MS
                    )
            }
        );


        await page
            .waitForTimeout(1200)
            .catch(() => {});


        const captchaDetected =
            await detectCaptcha(page);


        if (captchaDetected) {

            const verificationUrl =
                await createLiveUrl(page);


            const handoff =
                await handoffBrowserSession(
                    page,
                    browser
                );

            handedOff = true;


            const nextSessionId =
                createSignedSessionToken({
                    wsEndpoint:
                        handoff.browserWSEndpoint,

                    currentUrl:
                        page.url()
                });


            return res.status(403).json({

                success: false,

                requiresVerification: true,

                sessionId:
                    nextSessionId,

                verificationUrl,

                error: {
                    code:
                        "CAPTCHA_REQUIRED",

                    message:
                        "The source requires CAPTCHA verification."
                },

                meta: {
                    url:
                        page.url(),

                    duration:
                        Date.now() -
                        startedAt
                }

            });

        }


        const html =
            await page.content();


        const currentUrl =
            page.url();


        const handoff =
            await handoffBrowserSession(
                page,
                browser
            );

        handedOff = true;


        const nextSessionId =
            createSignedSessionToken({
                wsEndpoint:
                    handoff.browserWSEndpoint,

                currentUrl
            });


        return respondWithExtractedContent({
            res,

            html,

            currentUrl,

            sessionId:
                nextSessionId,

            method,
            timeout,
            mode,
            content,
            startedAt
        });


    } finally {

        if (
            browser &&
            !handedOff
        ) {

            await closeQuietly(
                browser
            );

        }

    }

}


/* =========================================================
   CONTINUE EXISTING SESSION
   ========================================================= */

async function continueScrapingSession({
    res,
    sessionId,
    method,
    timeout,
    mode,
    content
}) {

    validateConfiguration({
        method,
        timeout,
        content
    });


    if (!sessionId) {

        return res.status(400).json({
            success: false,
            error: {
                code:
                    "MISSING_SESSION_ID",

                message:
                    "A browser session is required."
            }
        });

    }


    const sessionData =
        verifySignedSessionToken(
            sessionId
        );


    const startedAt =
        Date.now();

    let browser = null;
    let handedOff = false;


    try {

        browser =
            await reconnectToBrowserlessSession(
                sessionData.wsEndpoint
            );


        const { page } =
            await getOrCreatePage(browser);


        await page
            .waitForTimeout(500)
            .catch(() => {});


        const captchaDetected =
            await detectCaptcha(page);


        if (captchaDetected) {

            const verificationUrl =
                await createLiveUrl(page);


            const handoff =
                await handoffBrowserSession(
                    page,
                    browser
                );

            handedOff = true;


            const nextSessionId =
                createSignedSessionToken({
                    wsEndpoint:
                        handoff.browserWSEndpoint,

                    currentUrl:
                        page.url()
                });


            return res.status(403).json({

                success: false,

                requiresVerification: true,

                sessionId:
                    nextSessionId,

                verificationUrl,

                error: {
                    code:
                        "CAPTCHA_REQUIRED",

                    message:
                        "CAPTCHA verification is still required."
                }

            });

        }


        const html =
            await page.content();


        const currentUrl =
            page.url();


        const handoff =
            await handoffBrowserSession(
                page,
                browser
            );

        handedOff = true;


        const nextSessionId =
            createSignedSessionToken({
                wsEndpoint:
                    handoff.browserWSEndpoint,

                currentUrl
            });


        return respondWithExtractedContent({
            res,

            html,

            currentUrl,

            sessionId:
                nextSessionId,

            method,
            timeout,
            mode,
            content,
            startedAt
        });


    } finally {

        if (
            browser &&
            !handedOff
        ) {

            await closeQuietly(
                browser
            );

        }

    }

}


/* =========================================================
   EXTRACT CONTENT
   ========================================================= */

function respondWithExtractedContent({
    res,
    html,
    currentUrl,
    sessionId,
    method,
    timeout,
    mode,
    content,
    startedAt
}) {

    const targetUrl =
        new URL(currentUrl);


    const $ =
        cheerio.load(html);


    const metadata =
        extractMetadata(
            $,
            targetUrl
        );

    const text =
        extractText($);

    const links =
        extractLinks(
            $,
            targetUrl
        );

    const tables =
        extractTables($);


    const selectedContent = {

        metadata:
            content.includes("metadata")
                ? metadata
                : {},

        text:
            content.includes("text")
                ? text
                : [],

        links:
            content.includes("links")
                ? links
                : [],

        tables:
            content.includes("tables")
                ? tables
                : []

    };


    return res.status(200).json({

        success: true,

        requiresVerification: false,

        sessionId,

        data:
            selectedContent,

        meta: {

            url:
                currentUrl,

            contentLength:
                html.length,

            duration:
                Date.now() -
                startedAt

        },

        request: {
            method,
            timeout,
            mode,
            content
        }

    });

}


/* =========================================================
   BROWSERLESS CONNECTION
   ========================================================= */

async function connectToNewBrowserlessSession() {

    const token =
        encodeURIComponent(
            BROWSERLESS_TOKEN
        );


    const wsUrl =
        `${BROWSERLESS_WS_BASE}/stealth` +
        `?token=${token}` +
        `&blockAds=true`;


    return chromium.connectOverCDP(
        wsUrl,
        {
            timeout:
                NAVIGATION_TIMEOUT_MS
        }
    );

}


/* =========================================================
   RECONNECT
   ========================================================= */

async function reconnectToBrowserlessSession(
    wsEndpoint
) {

    const endpoint =
        appendToken(
            wsEndpoint,
            BROWSERLESS_TOKEN
        );


    try {

        return await chromium.connectOverCDP(
            endpoint,
            {
                timeout:
                    NAVIGATION_TIMEOUT_MS
            }
        );


    } catch (error) {

        const wrapped =
            new Error(
                "Browserless session is unavailable."
            );

        wrapped.code =
            "SESSION_EXPIRED";

        wrapped.httpStatus =
            410;

        wrapped.publicMessage =
            "The browser session expired. Start a new scraping request.";

        wrapped.cause =
            error;

        throw wrapped;

    }

}


/* =========================================================
   GET PAGE
   ========================================================= */

async function getOrCreatePage(
    browser
) {

    let context =
        browser.contexts()[0];


    if (!context) {

        context =
            await browser.newContext();

    }


    let pages =
        context.pages();


    let page =
        pages.find(
            candidate =>
                !candidate.isClosed()
        );


    if (!page) {

        page =
            await context.newPage();

    }


    page.setDefaultTimeout(
        NAVIGATION_TIMEOUT_MS
    );

    page.setDefaultNavigationTimeout(
        NAVIGATION_TIMEOUT_MS
    );


    return {
        context,
        page
    };

}


/* =========================================================
   BROWSERLESS HANDOFF
   ========================================================= */

async function handoffBrowserSession(
    page,
    browser
) {

    const cdp =
        await page
            .context()
            .newCDPSession(page);


    const result =
        await cdp.send(
            "Browserless.reconnect",
            {
                timeout:
                    RECONNECT_TIMEOUT_MS
            }
        );


    if (
        !result ||
        !result.browserWSEndpoint
    ) {

        const error =
            new Error(
                "Browserless did not return a reconnection endpoint."
            );

        error.code =
            "RECONNECT_FAILED";

        error.httpStatus =
            502;

        error.publicMessage =
            "Browserless could not preserve the browser session.";

        throw error;

    }


    await browser.close();


    return result;

}


/* =========================================================
   LIVE URL
   ========================================================= */

async function createLiveUrl(
    page
) {

    try {

        const cdp =
            await page
                .context()
                .newCDPSession(page);


        const result =
            await cdp.send(
                "Browserless.liveURL",
                {
                    timeout:
                        LIVE_URL_TIMEOUT_MS,

                    interactable:
                        true,

                    resizable:
                        true,

                    showBrowserInterface:
                        true,

                    quality:
                        70,

                    type:
                        "jpeg"
                }
            );


        if (result?.error) {

            console.error(
                "Browserless.liveURL error:",
                result.error
            );

            return null;

        }


        return (
            result?.liveURL ||
            null
        );


    } catch (error) {

        console.error(
            "Live URL creation error:",
            safeError(error)
        );

        return null;

    }

}


/* =========================================================
   CAPTCHA DETECTION
   ========================================================= */

async function detectCaptcha(
    page
) {

    try {

        const title =
            await page
                .title()
                .catch(() => "");


        const bodyText =
            await page
                .locator("body")
                .innerText({
                    timeout: 4000
                })
                .catch(() => "");


        const combinedText =
            `${title} ${bodyText}`
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

            "por favor complete la validación",
            "complete la validación",

            "verificación de seguridad",

            "verifica que eres humano",
            "verifique que es humano"

        ];


        if (
            textSignals.some(
                signal =>
                    combinedText.includes(
                        signal
                    )
            )
        ) {

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


        for (
            const selector
            of selectorSignals
        ) {

            const count =
                await page
                    .locator(selector)
                    .count()
                    .catch(() => 0);


            if (count > 0) {

                return true;

            }

        }


        return false;


    } catch (error) {

        console.error(
            "CAPTCHA detection error:",
            safeError(error)
        );

        return false;

    }

}


/* =========================================================
   SIGNED SESSION TOKEN
   ========================================================= */

function createSignedSessionToken({
    wsEndpoint,
    currentUrl
}) {

    const now =
        Date.now();


    const payload = {

        v: 1,

        ws:
            wsEndpoint,

        url:
            currentUrl || null,

        iat:
            now,

        exp:
            now +
            SESSION_TOKEN_TTL_MS

    };


    const encodedPayload =
        Buffer
            .from(
                JSON.stringify(
                    payload
                ),
                "utf8"
            )
            .toString(
                "base64url"
            );


    const signature =
        crypto
            .createHmac(
                "sha256",
                SESSION_SECRET
            )
            .update(
                encodedPayload
            )
            .digest(
                "base64url"
            );


    return (
        `${encodedPayload}.${signature}`
    );

}


/* =========================================================
   VERIFY SESSION TOKEN
   ========================================================= */

function verifySignedSessionToken(
    token
) {

    if (
        !token ||
        typeof token !== "string"
    ) {

        throwSessionTokenError();

    }


    const separatorIndex =
        token.lastIndexOf(".");


    if (
        separatorIndex <= 0
    ) {

        throwSessionTokenError();

    }


    const encodedPayload =
        token.slice(
            0,
            separatorIndex
        );


    const providedSignature =
        token.slice(
            separatorIndex + 1
        );


    const expectedSignature =
        crypto
            .createHmac(
                "sha256",
                SESSION_SECRET
            )
            .update(
                encodedPayload
            )
            .digest(
                "base64url"
            );


    const providedBuffer =
        Buffer.from(
            providedSignature
        );


    const expectedBuffer =
        Buffer.from(
            expectedSignature
        );


    if (
        providedBuffer.length !==
            expectedBuffer.length ||
        !crypto.timingSafeEqual(
            providedBuffer,
            expectedBuffer
        )
    ) {

        throwSessionTokenError();

    }


    let payload;


    try {

        payload =
            JSON.parse(
                Buffer
                    .from(
                        encodedPayload,
                        "base64url"
                    )
                    .toString(
                        "utf8"
                    )
            );


    } catch {

        throwSessionTokenError();

    }


    if (
        payload?.v !== 1 ||
        typeof payload?.ws !==
            "string" ||
        !payload.ws.startsWith(
            "wss://"
        )
    ) {

        throwSessionTokenError();

    }


    if (
        !Number.isFinite(
            payload.exp
        ) ||
        Date.now() >
            payload.exp
    ) {

        const error =
            new Error(
                "Session token expired."
            );

        error.code =
            "SESSION_TOKEN_EXPIRED";

        error.httpStatus =
            410;

        error.publicMessage =
            "The browser session expired. Start a new scraping request.";

        throw error;

    }


    return {

        wsEndpoint:
            payload.ws,

        currentUrl:
            payload.url || null

    };

}


/* =========================================================
   INVALID SESSION TOKEN
   ========================================================= */

function throwSessionTokenError() {

    const error =
        new Error(
            "Invalid session token."
        );

    error.code =
        "INVALID_SESSION_ID";

    error.httpStatus =
        400;

    error.publicMessage =
        "The supplied browser session is not valid.";

    throw error;

}


/* =========================================================
   URL VALIDATION
   ========================================================= */

function validateTargetUrl(
    value
) {

    if (
        !value ||
        typeof value !== "string"
    ) {

        const error =
            new Error(
                "URL is required."
            );

        error.code =
            "MISSING_URL";

        error.httpStatus =
            400;

        error.publicMessage =
            "A URL is required.";

        throw error;

    }


    let targetUrl;


    try {

        targetUrl =
            new URL(value);


    } catch {

        const error =
            new Error(
                "Invalid URL."
            );

        error.code =
            "INVALID_URL";

        error.httpStatus =
            400;

        error.publicMessage =
            "The provided URL is not valid.";

        throw error;

    }


    if (
        !["http:", "https:"]
            .includes(
                targetUrl.protocol
            )
    ) {

        const error =
            new Error(
                "Unsupported protocol."
            );

        error.code =
            "UNSUPPORTED_PROTOCOL";

        error.httpStatus =
            400;

        error.publicMessage =
            "Only HTTP and HTTPS URLs are supported.";

        throw error;

    }


    const hostname =
        targetUrl.hostname
            .toLowerCase();


    if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname.endsWith(
            ".local"
        )
    ) {

        const error =
            new Error(
                "Local targets are not allowed."
            );

        error.code =
            "LOCAL_URL_NOT_ALLOWED";

        error.httpStatus =
            400;

        error.publicMessage =
            "Local URLs are not allowed.";

        throw error;

    }


    return targetUrl;

}


/* =========================================================
   REQUEST VALIDATION
   ========================================================= */

function validateConfiguration({
    method,
    timeout,
    content
}) {

    if (
        method !== "GET"
    ) {

        const error =
            new Error(
                "Unsupported request method."
            );

        error.code =
            "UNSUPPORTED_METHOD";

        error.httpStatus =
            400;

        error.publicMessage =
            "Only GET requests are supported.";

        throw error;

    }


    const timeoutSeconds =
        Number(timeout);


    if (
        ![5, 10, 20, 30]
            .includes(
                timeoutSeconds
            )
    ) {

        const error =
            new Error(
                "Invalid timeout."
            );

        error.code =
            "INVALID_TIMEOUT";

        error.httpStatus =
            400;

        error.publicMessage =
            "Timeout must be 5, 10, 20 or 30 seconds.";

        throw error;

    }


    if (
        !Array.isArray(
            content
        ) ||
        content.length === 0
    ) {

        const error =
            new Error(
                "No content selected."
            );

        error.code =
            "INVALID_CONTENT";

        error.httpStatus =
            400;

        error.publicMessage =
            "Select at least one data type to extract.";

        throw error;

    }

}


/* =========================================================
   ENVIRONMENT CONFIGURATION
   ========================================================= */

function assertConfiguration() {

    if (
        !BROWSERLESS_TOKEN
    ) {

        const error =
            new Error(
                "BROWSERLESS_TOKEN is missing."
            );

        error.code =
            "BROWSERLESS_NOT_CONFIGURED";

        error.httpStatus =
            500;

        error.publicMessage =
            "Browserless is not configured.";

        throw error;

    }


    if (
        !SESSION_SECRET ||
        SESSION_SECRET.length < 32
    ) {

        const error =
            new Error(
                "SESSION_SECRET is missing."
            );

        error.code =
            "SESSION_SECRET_NOT_CONFIGURED";

        error.httpStatus =
            500;

        error.publicMessage =
            "SESSION_SECRET must contain at least 32 characters.";

        throw error;

    }

}


/* =========================================================
   HELPERS
   ========================================================= */

function appendToken(
    endpoint,
    token
) {

    const separator =
        endpoint.includes("?")
            ? "&"
            : "?";


    return (
        `${endpoint}${separator}` +
        `token=${encodeURIComponent(token)}`
    );

}


async function closeQuietly(
    browser
) {

    try {

        await browser.close();

    } catch (error) {

        console.error(
            "Browser close error:",
            safeError(error)
        );

    }

}


function safeError(
    error
) {

    return {

        name:
            error?.name,

        message:
            error?.message,

        code:
            error?.code

    };

}


/* =========================================================
   METADATA
   ========================================================= */

function extractMetadata(
    $,
    targetUrl
) {

    return {

        title:
            $("title")
                .first()
                .text()
                .trim() ||
            null,

        description:
            $('meta[name="description"]')
                .attr("content")
                ?.trim() ||
            null,

        canonical:
            $('link[rel="canonical"]')
                .attr("href") ||
            targetUrl.toString()

    };

}


/* =========================================================
   TEXT
   ========================================================= */

function extractText(
    $
) {

    const text = [];


    $(
        "h1, h2, h3, h4, h5, h6, p"
    ).each(
        (_, element) => {

            const value =
                $(element)
                    .text()
                    .replace(
                        /\s+/g,
                        " "
                    )
                    .trim();


            if (value) {

                text.push(
                    value
                );

            }

        }
    );


    return text;

}


/* =========================================================
   LINKS
   ========================================================= */

function extractLinks(
    $,
    baseUrl
) {

    const links = [];


    $("a[href]").each(
        (_, element) => {

            const text =
                $(element)
                    .text()
                    .replace(
                        /\s+/g,
                        " "
                    )
                    .trim();


            const href =
                $(element)
                    .attr("href");


            if (!href) {
                return;
            }


            try {

                const absoluteUrl =
                    new URL(
                        href,
                        baseUrl
                    ).toString();


                links.push({

                    text:
                        text ||
                        absoluteUrl,

                    url:
                        absoluteUrl

                });


            } catch {

                // Ignore malformed URLs

            }

        }
    );


    return links;

}


/* =========================================================
   TABLES
   ========================================================= */

function extractTables(
    $
) {

    const tables = [];


    $("table").each(
        (_, table) => {

            const rows = [];


            $(table)
                .find("tr")
                .each(
                    (_, row) => {

                        const cells = [];


                        $(row)
                            .find(
                                "th, td"
                            )
                            .each(
                                (_, cell) => {

                                    const value =
                                        $(cell)
                                            .text()
                                            .replace(
                                                /\s+/g,
                                                " "
                                            )
                                            .trim();


                                    cells.push(
                                        value
                                    );

                                }
                            );


                        if (
                            cells.some(
                                Boolean
                            )
                        ) {

                            rows.push(
                                cells
                            );

                        }

                    }
                );


            if (!rows.length) {
                return;
            }


            let headers = [];
            let dataRows = rows;


            const firstRow =
                rows[0];


            const firstRowHasTh =
                $(table)
                    .find("tr")
                    .first()
                    .find("th")
                    .length > 0;


            if (
                firstRowHasTh &&
                firstRow.length > 1
            ) {

                headers =
                    firstRow;

                dataRows =
                    rows.slice(1);

            }


            const keyValue = [];


            for (
                const row
                of rows
            ) {

                if (
                    row.length < 2
                ) {

                    continue;

                }


                const key =
                    row[0];


                const value =
                    row
                        .slice(1)
                        .filter(Boolean)
                        .join(" | ");


                if (
                    key &&
                    value
                ) {

                    keyValue.push({
                        key,
                        value
                    });

                }

            }


            tables.push({

                headers,

                rows:
                    dataRows,

                keyValue

            });

        }
    );


    return tables;

}