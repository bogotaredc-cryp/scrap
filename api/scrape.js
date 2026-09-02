"use strict";

module.exports = async function handler(req, res) {
    // --------------------------------------------------
    // 1. Method validation
    // --------------------------------------------------

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
        // --------------------------------------------------
        // 2. Read request body
        // --------------------------------------------------

        const {
            url,
            method = "GET",
            timeout = 10,
            mode = "auto",
            content = []
        } = req.body || {};

        // --------------------------------------------------
        // 3. Validate URL
        // --------------------------------------------------

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
        // 4. Request configuration
        // --------------------------------------------------

        if (method !== "GET") {
            return res.status(400).json({
                success: false,
                error: {
                    code: "UNSUPPORTED_METHOD",
                    message: "Only GET requests are supported in this version."
                }
            });
        }

        const timeoutSeconds = Number(timeout);

        if (![5, 10, 20, 30].includes(timeoutSeconds)) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "INVALID_TIMEOUT",
                    message: "Timeout must be 5, 10, 20 or 30 seconds."
                }
            });
        }

        // --------------------------------------------------
        // 5. Start request
        // --------------------------------------------------

        const startedAt = Date.now();

        const controller = new AbortController();

        const timeoutId = setTimeout(() => {
            controller.abort();
        }, timeoutSeconds * 1000);

        let response;

        try {
            response = await fetch(targetUrl.toString(), {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; WebScraper/0.2)"
                },
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeoutId);
        }

        // --------------------------------------------------
        // 6. Read response
        // --------------------------------------------------

        const html = await response.text();

        const duration = Date.now() - startedAt;

        // --------------------------------------------------
        // 7. Return fetch result
        // --------------------------------------------------

        return res.status(200).json({
            success: true,

            data: {
                html
            },

            meta: {
                url: targetUrl.toString(),
                status: response.status,
                statusText: response.statusText,
                contentType: response.headers.get("content-type"),
                contentLength: html.length,
                duration
            },

            request: {
                method,
                timeout: timeoutSeconds,
                mode,
                content
            }
        });

    } catch (error) {
        console.error("Scraper API error:", error);

        if (error.name === "AbortError") {
            return res.status(408).json({
                success: false,
                error: {
                    code: "REQUEST_TIMEOUT",
                    message: "The source took too long to respond."
                }
            });
        }

        return res.status(500).json({
            success: false,
            error: {
                code: "FETCH_FAILED",
                message: "The requested source could not be fetched."
            }
        });
    }
};