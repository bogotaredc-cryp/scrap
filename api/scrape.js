"use strict";

module.exports = async function handler(req, res) {
    // Solo permitimos POST
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
        const { url, method, timeout, mode, content } = req.body || {};

        // Validación básica
        if (!url) {
            return res.status(400).json({
                success: false,
                error: {
                    code: "MISSING_URL",
                    message: "A URL is required."
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: "Scraper endpoint connected.",
            request: {
                url,
                method: method || "GET",
                timeout: timeout || 10,
                mode: mode || "auto",
                content: Array.isArray(content) ? content : []
            }
        });

    } catch (error) {
        console.error("Scraper API error:", error);

        return res.status(500).json({
            success: false,
            error: {
                code: "INTERNAL_ERROR",
                message: "An internal error occurred while processing the request."
            }
        });
    }
};